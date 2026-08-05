import { readFileSync } from 'node:fs'

import type { ServerResponse } from 'node:http'

import { createM1StaticFmp4Fixture } from '../../fixtures/m1-static-fmp4'

import type { Plugin } from 'vitest/config'

type StreamState = {
  active: boolean
  opened: number
  closed: number
  chunks: number
  bytes: number
  connections: StreamConnectionState[]
}

type StreamConnectionState = {
  sequence: number
  active: boolean
  chunks: number
  bytes: number
  closed: boolean
}

export function createBrowserTestServer(): Plugin {
  const streamStates = new Map<string, StreamState>()
  const activeResponses = new Map<string, Map<number, ServerResponse>>()

  return {
    name: 'rivmux-browser-test-server',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost')

        if (url.pathname === '/__rivmux-test/reset') {
          if (request.method !== 'POST') {
            respondWithJson(response, 405, { error: 'method-not-allowed', allowed: ['POST'] }, { allow: 'POST' })
            return
          }

          const requestedIds = url.searchParams.getAll('id')
          const resetIds = requestedIds.length === 0 ? undefined : new Set(requestedIds)
          for (const [id, responses] of activeResponses) {
            if (resetIds !== undefined && !resetIds.has(id)) {
              continue
            }
            for (const activeResponse of responses.values()) {
              if (!activeResponse.writableEnded) {
                activeResponse.end()
              }
            }
            activeResponses.delete(id)
          }
          if (resetIds === undefined) {
            streamStates.clear()
          } else {
            for (const id of resetIds) {
              streamStates.delete(id)
            }
          }
          response.writeHead(204)
          response.end()
          return
        }

        if (url.pathname === '/__rivmux-test/stats') {
          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
          })
          response.end(JSON.stringify(Object.fromEntries(streamStates)))
          return
        }

        const controlMatch = /^\/__rivmux-test\/stream\/([^/]+)\/control$/.exec(url.pathname)
        if (controlMatch !== null) {
          if (request.method !== 'POST') {
            respondWithJson(response, 405, { error: 'method-not-allowed', allowed: ['POST'] }, { allow: 'POST' })
            return
          }

          const action = url.searchParams.get('action')
          if (action !== 'end') {
            respondWithJson(response, 400, { error: 'invalid-action', supported: ['end'] })
            return
          }

          const connectionSequence = parsePositiveInteger(url.searchParams.get('connection'))
          if (connectionSequence === undefined) {
            respondWithJson(response, 400, { error: 'invalid-connection', message: 'connection must be a positive integer' })
            return
          }

          const id = controlMatch[1]
          const state = streamStates.get(id)
          const connection = state?.connections.find(({ sequence }) => sequence === connectionSequence)
          if (state === undefined || connection === undefined) {
            respondWithJson(response, 404, { error: 'connection-not-found', id, connection: connectionSequence })
            return
          }

          const activeResponse = activeResponses.get(id)?.get(connectionSequence)
          if (!connection.active || activeResponse === undefined || activeResponse.writableEnded) {
            respondWithJson(response, 409, { error: 'connection-not-active', id, connection: connectionSequence })
            return
          }

          activeResponse.end()
          respondWithJson(response, 200, { action: 'end', id, connection: connectionSequence })
          return
        }

        const match = /^\/__rivmux-test\/stream\/([^/]+)\.flv$/.exec(url.pathname)
        if (match === null) {
          next()
          return
        }

        const id = match[1]
        const state = getStreamState(streamStates, id)
        const connection = createConnectionState(state)
        registerActiveResponse(activeResponses, id, connection.sequence, response)
        state.active = true
        state.opened += 1

        const timers: {
          stalledWrite?: ReturnType<typeof setTimeout>
          playableWrite?: ReturnType<typeof setInterval>
          repeatedWrite?: ReturnType<typeof setInterval>
        } = {}
        let cleanedUp = false
        const cleanup = (): void => {
          if (cleanedUp) {
            return
          }
          cleanedUp = true

          if (timers.stalledWrite !== undefined) {
            clearTimeout(timers.stalledWrite)
          }
          if (timers.playableWrite !== undefined) {
            clearInterval(timers.playableWrite)
          }
          if (timers.repeatedWrite !== undefined) {
            clearInterval(timers.repeatedWrite)
          }

          connection.active = false
          connection.closed = true
          state.closed += 1
          state.active = state.connections.some(({ active }) => active)
          unregisterActiveResponse(activeResponses, id, connection.sequence, response)
        }
        response.once('close', cleanup)
        response.once('finish', cleanup)

        const forcedStatus = parsePositiveInteger(url.searchParams.get('status'))
        if (forcedStatus !== undefined) {
          response.writeHead(forcedStatus, {
            'cache-control': 'no-store',
            'content-type': 'text/plain; charset=utf-8',
          })
          response.end(`forced status ${forcedStatus}`)
          return
        }

        response.writeHead(200, {
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'content-type': 'video/x-flv',
        })

        const fixture = url.searchParams.get('fixture')
        const isPlayableFixture = fixture === 'h264-aac-playable' || fixture === 'hevc-aac-playable'
        const isCoreFixture = isPlayableFixture || fixture === 'h264' || fixture === 'h264-aac' || fixture === 'h264-aac-late-config' || fixture === 'opus'
        const chunk = isPlayableFixture
          ? fixture === 'hevc-aac-playable'
            ? HEVC_AAC_PLAYABLE_FLV
            : H264_AAC_PLAYABLE_FLV
          : fixture === 'h264'
            ? createCoreH264FlvFixture()
            : fixture === 'h264-aac'
              ? createCoreH264AacFlvFixture()
              : fixture === 'h264-aac-late-config'
                ? createCoreH264AacLateConfigFlvFixture()
                : fixture === 'opus'
                  ? createCoreOpusFlvFixture()
                  : new Uint8Array([70, 76, 86, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0])
        const writeChunk = (bytes: Uint8Array): void => {
          if (response.writableEnded) {
            return
          }

          state.chunks += 1
          state.bytes += bytes.byteLength
          connection.chunks += 1
          connection.bytes += bytes.byteLength
          response.write(bytes)
        }

        const stallMs = parsePositiveInteger(url.searchParams.get('stallMs'))
        const splitAt = Math.max(1, Math.min(chunk.byteLength - 1, Math.floor(chunk.byteLength / 2)))
        if (isCoreFixture && stallMs !== undefined && chunk.byteLength > 1) {
          writeChunk(chunk.slice(0, splitAt))
          timers.stalledWrite = setTimeout(() => {
            writeChunk(chunk.slice(splitAt))
          }, stallMs)
        } else if (isPlayableFixture) {
          let offset = 0
          timers.playableWrite = setInterval(() => {
            const end = Math.min(offset + 16 * 1024, chunk.byteLength)
            writeChunk(chunk.slice(offset, end))
            offset = end
            if (offset >= chunk.byteLength && timers.playableWrite !== undefined) {
              clearInterval(timers.playableWrite)
              timers.playableWrite = undefined
            }
          }, 10)
        } else {
          writeChunk(chunk)
        }
        timers.repeatedWrite = isCoreFixture ? undefined : setInterval(() => writeChunk(chunk), 50)
      })
    },
  }
}

const H264_AAC_PLAYABLE_FLV = new Uint8Array(readFileSync(new URL('../../../crates/transmux-fixtures/fixtures/h264-aac.flv', import.meta.url)))
const HEVC_AAC_PLAYABLE_FLV = new Uint8Array(readFileSync(new URL('../../../crates/transmux-fixtures/fixtures/hevc-aac.flv', import.meta.url)))

function getStreamState(streamStates: Map<string, StreamState>, id: string): StreamState {
  const existing = streamStates.get(id)
  if (existing !== undefined) {
    return existing
  }

  const state = {
    active: false,
    opened: 0,
    closed: 0,
    chunks: 0,
    bytes: 0,
    connections: [],
  }
  streamStates.set(id, state)
  return state
}

function createConnectionState(state: StreamState): StreamConnectionState {
  const connection = {
    sequence: state.opened + 1,
    active: true,
    chunks: 0,
    bytes: 0,
    closed: false,
  }
  state.connections.push(connection)
  return connection
}

function registerActiveResponse(activeResponses: Map<string, Map<number, ServerResponse>>, id: string, sequence: number, response: ServerResponse): void {
  let responses = activeResponses.get(id)
  if (responses === undefined) {
    responses = new Map()
    activeResponses.set(id, responses)
  }
  responses.set(sequence, response)
}

function unregisterActiveResponse(activeResponses: Map<string, Map<number, ServerResponse>>, id: string, sequence: number, response: ServerResponse): void {
  const responses = activeResponses.get(id)
  if (responses?.get(sequence) !== response) {
    return
  }

  responses.delete(sequence)
  if (responses.size === 0) {
    activeResponses.delete(id)
  }
}

function respondWithJson(response: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  })
  response.end(JSON.stringify(body))
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (value === null) {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

let cachedCoreH264FlvFixture: Uint8Array | undefined
let cachedCoreH264AacFlvFixture: Uint8Array | undefined
let cachedCoreH264AacLateConfigFlvFixture: Uint8Array | undefined
let cachedCoreOpusFlvFixture: Uint8Array | undefined

function createCoreH264FlvFixture(): Uint8Array {
  cachedCoreH264FlvFixture ??= buildCoreH264FlvFixture()
  return cachedCoreH264FlvFixture
}

function createCoreH264AacFlvFixture(): Uint8Array {
  cachedCoreH264AacFlvFixture ??= buildCoreH264AacFlvFixture()
  return cachedCoreH264AacFlvFixture
}

function createCoreH264AacLateConfigFlvFixture(): Uint8Array {
  cachedCoreH264AacLateConfigFlvFixture ??= buildCoreH264AacLateConfigFlvFixture()
  return cachedCoreH264AacLateConfigFlvFixture
}

function createCoreOpusFlvFixture(): Uint8Array {
  cachedCoreOpusFlvFixture ??= buildCoreOpusFlvFixture()
  return cachedCoreOpusFlvFixture
}

function buildCoreH264FlvFixture(): Uint8Array {
  const fixture = createM1StaticFmp4Fixture()
  const initSegment = new Uint8Array(fixture.initSegment)
  const mediaSegment = new Uint8Array(fixture.mediaSegment)
  const avcc = findBoxPayload(initSegment, 'avcC')
  const idrSample = findFirstVideoSample(mediaSegment)

  return concatBytes([flvHeader(false), videoSequenceHeaderTag(avcc), videoSampleTag(0, true, 0, idrSample)])
}

function buildCoreH264AacFlvFixture(): Uint8Array {
  const fixture = createM1StaticFmp4Fixture()
  const initSegment = new Uint8Array(fixture.initSegment)
  const mediaSegment = new Uint8Array(fixture.mediaSegment)
  const avcc = findBoxPayload(initSegment, 'avcC')
  const idrSample = findFirstVideoSample(mediaSegment)

  return concatBytes([
    flvHeader(true),
    videoSequenceHeaderTag(avcc),
    audioSequenceHeaderTag(new Uint8Array([0x12, 0x10])),
    videoSampleTag(0, true, 0, idrSample),
    audioSampleTag(0, new Uint8Array([0x21, 0x22, 0x23, 0x24])),
  ])
}

function buildCoreH264AacLateConfigFlvFixture(): Uint8Array {
  const fixture = createM1StaticFmp4Fixture()
  const initSegment = new Uint8Array(fixture.initSegment)
  const mediaSegment = new Uint8Array(fixture.mediaSegment)
  const avcc = findBoxPayload(initSegment, 'avcC')
  const idrSample = findFirstVideoSample(mediaSegment)

  return concatBytes([
    flvHeader(true),
    videoSequenceHeaderTag(avcc),
    videoSampleTag(0, true, 0, idrSample),
    videoSampleTag(40, false, 0, idrSample),
    audioSequenceHeaderTag(new Uint8Array([0x12, 0x10])),
    audioSampleTag(0, new Uint8Array([0x21, 0x22, 0x23, 0x24])),
    videoSampleTag(80, false, 0, idrSample),
  ])
}

function buildCoreOpusFlvFixture(): Uint8Array {
  return concatBytes([audioOnlyFlvHeader(), opusSequenceHeaderTag(), opusSampleTag(20)])
}

function flvHeader(hasAudio: boolean): Uint8Array {
  return new Uint8Array([0x46, 0x4c, 0x56, 1, hasAudio ? 5 : 1, 0, 0, 0, 9, 0, 0, 0, 0])
}

function audioOnlyFlvHeader(): Uint8Array {
  return new Uint8Array([0x46, 0x4c, 0x56, 1, 4, 0, 0, 0, 9, 0, 0, 0, 0])
}

function videoSequenceHeaderTag(avcc: Uint8Array): Uint8Array {
  return rawFlvTag(9, 0, concatBytes([new Uint8Array([0x17, 0, 0, 0, 0]), avcc]))
}

function videoSampleTag(timestampMs: number, isKeyframe: boolean, compositionTimeMs: number, sample: Uint8Array): Uint8Array {
  return rawFlvTag(9, timestampMs, concatBytes([new Uint8Array([isKeyframe ? 0x17 : 0x27, 1, ...i24(compositionTimeMs)]), sample]))
}

function audioSequenceHeaderTag(audioSpecificConfig: Uint8Array): Uint8Array {
  return rawFlvTag(8, 0, concatBytes([new Uint8Array([0xaf, 0]), audioSpecificConfig]))
}

function audioSampleTag(timestampMs: number, sample: Uint8Array): Uint8Array {
  return rawFlvTag(8, timestampMs, concatBytes([new Uint8Array([0xaf, 1]), sample]))
}

function opusSequenceHeaderTag(): Uint8Array {
  return rawFlvTag(8, 0, concatBytes([new Uint8Array([0x90, 0x4f, 0x70, 0x75, 0x73]), OPUS_HEAD]))
}

function opusSampleTag(timestampMs: number): Uint8Array {
  return rawFlvTag(8, timestampMs, concatBytes([new Uint8Array([0x91, 0x4f, 0x70, 0x75, 0x73]), OPUS_PACKET]))
}

function rawFlvTag(tagType: number, timestampMs: number, payload: Uint8Array): Uint8Array {
  const previousTagSize = 11 + payload.byteLength
  return concatBytes([
    new Uint8Array([tagType, ...u24(payload.byteLength), ...u24(timestampMs & 0x00ff_ffff), (timestampMs >> 24) & 0xff, 0, 0, 0]),
    payload,
    new Uint8Array([(previousTagSize >> 24) & 0xff, (previousTagSize >> 16) & 0xff, (previousTagSize >> 8) & 0xff, previousTagSize & 0xff]),
  ])
}

const OPUS_HEAD = new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 0x01, 0x01, 0x38, 0x01, 0x80, 0xbb, 0x00, 0x00, 0x00, 0x00, 0x00])

const OPUS_PACKET = new Uint8Array([0x0b, 0x41, 0x06, 0x0b, 0xe4, 0x53, 0x15, 0x4b, 0xf2, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])

function findFirstVideoSample(mediaSegment: Uint8Array): Uint8Array {
  const trun = findBox(mediaSegment, 'trun')
  const mdat = findBox(mediaSegment, 'mdat')
  if (trun === undefined || mdat === undefined) {
    throw new Error('M1 fMP4 fixture is missing trun or mdat.')
  }

  const flags = readU24(mediaSegment, trun.offset + 9)
  const sampleCount = readU32(mediaSegment, trun.offset + 12)
  let offset = trun.offset + 16
  if ((flags & 0x000001) !== 0) {
    offset += 4
  }
  if ((flags & 0x000004) !== 0) {
    offset += 4
  }

  for (let index = 0; index < sampleCount; index += 1) {
    if ((flags & 0x000100) !== 0) {
      offset += 4
    }
    const sampleSize = (flags & 0x000200) === 0 ? undefined : readU32(mediaSegment, offset)
    if ((flags & 0x000200) !== 0) {
      offset += 4
    }
    if ((flags & 0x000400) !== 0) {
      offset += 4
    }
    if ((flags & 0x000800) !== 0) {
      offset += 4
    }

    if (index === 0) {
      if (sampleSize === undefined) {
        throw new Error('M1 fMP4 fixture trun does not include sample sizes.')
      }
      const sampleOffset = mdat.offset + 8
      return mediaSegment.slice(sampleOffset, sampleOffset + sampleSize)
    }
  }

  throw new Error('M1 fMP4 fixture does not contain video samples.')
}

function findBoxPayload(bytes: Uint8Array, type: string): Uint8Array {
  const box = findBox(bytes, type)
  if (box === undefined) {
    throw new Error(`M1 fMP4 fixture is missing ${type}.`)
  }

  return bytes.slice(box.offset + 8, box.offset + box.size)
}

type Mp4Box = {
  offset: number
  size: number
}

function findBox(bytes: Uint8Array, type: string, start = 0, end = bytes.byteLength): Mp4Box | undefined {
  let offset = start
  while (offset + 8 <= end) {
    const size = readU32(bytes, offset)
    if (size < 8 || offset + size > end) {
      return undefined
    }

    const boxType = readBoxType(bytes, offset)
    if (boxType === type) {
      return { offset, size }
    }

    const childStart = childBoxStart(boxType, offset)
    if (childStart !== undefined && childStart < offset + size) {
      const child = findBox(bytes, type, childStart, offset + size)
      if (child !== undefined) {
        return child
      }
    }

    offset += size
  }

  return undefined
}

function childBoxStart(type: string, offset: number): number | undefined {
  if (type === 'stsd') {
    return offset + 16
  }
  if (type === 'avc1') {
    return offset + 86
  }
  if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf'].includes(type)) {
    return offset + 8
  }
  return undefined
}

function readBoxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) * 0x01_00_00_00 + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0)
}

function readU24(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 16) | ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset + 2] ?? 0)
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function u24(value: number): [number, number, number] {
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

function i24(value: number): [number, number, number] {
  return u24(value & 0x00ff_ffff)
}
