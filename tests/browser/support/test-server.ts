import { createM1StaticFmp4Fixture } from '../../fixtures/m1-static-fmp4'

import type { Plugin } from 'vitest/config'

type StreamState = {
  active: boolean
  opened: number
  closed: number
  chunks: number
  bytes: number
}

export function createBrowserTestServer(): Plugin {
  const streamStates = new Map<string, StreamState>()

  return {
    name: 'rivmux-browser-test-server',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost')

        if (url.pathname === '/__rivmux-test/reset') {
          streamStates.clear()
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

        const match = /^\/__rivmux-test\/stream\/([^/]+)\.flv$/.exec(url.pathname)
        if (match === null) {
          next()
          return
        }

        const id = match[1]
        const state = getStreamState(streamStates, id)
        state.active = true
        state.opened += 1

        const forcedStatus = parsePositiveInteger(url.searchParams.get('status'))
        if (forcedStatus !== undefined) {
          response.writeHead(forcedStatus, {
            'cache-control': 'no-store',
            'content-type': 'text/plain; charset=utf-8',
          })
          response.end(`forced status ${forcedStatus}`)
          state.active = false
          state.closed += 1
          return
        }

        response.writeHead(200, {
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'content-type': 'video/x-flv',
        })

        const fixture = url.searchParams.get('fixture')
        const isCoreFixture = fixture === 'h264' || fixture === 'h264-aac'
        const chunk =
          fixture === 'h264'
            ? createCoreH264FlvFixture()
            : fixture === 'h264-aac'
              ? createCoreH264AacFlvFixture()
              : new Uint8Array([70, 76, 86, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0])
        const writeChunk = (bytes: Uint8Array): void => {
          if (response.writableEnded) {
            return
          }

          state.chunks += 1
          state.bytes += bytes.byteLength
          response.write(bytes)
        }

        const stallMs = parsePositiveInteger(url.searchParams.get('stallMs'))
        const splitAt = Math.max(1, Math.min(chunk.byteLength - 1, Math.floor(chunk.byteLength / 2)))
        let stalledWriteTimer: ReturnType<typeof setTimeout> | undefined
        if (isCoreFixture && stallMs !== undefined && chunk.byteLength > 1) {
          writeChunk(chunk.slice(0, splitAt))
          stalledWriteTimer = setTimeout(() => {
            writeChunk(chunk.slice(splitAt))
          }, stallMs)
        } else {
          writeChunk(chunk)
        }
        const interval = isCoreFixture ? undefined : setInterval(() => writeChunk(chunk), 50)
        request.on('close', () => {
          if (stalledWriteTimer !== undefined) {
            clearTimeout(stalledWriteTimer)
          }
          if (interval !== undefined) {
            clearInterval(interval)
          }
          state.active = false
          state.closed += 1
        })
      })
    },
  }
}

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
  }
  streamStates.set(id, state)
  return state
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

function createCoreH264FlvFixture(): Uint8Array {
  cachedCoreH264FlvFixture ??= buildCoreH264FlvFixture()
  return cachedCoreH264FlvFixture
}

function createCoreH264AacFlvFixture(): Uint8Array {
  cachedCoreH264AacFlvFixture ??= buildCoreH264AacFlvFixture()
  return cachedCoreH264AacFlvFixture
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

function flvHeader(hasAudio: boolean): Uint8Array {
  return new Uint8Array([0x46, 0x4c, 0x56, 1, hasAudio ? 5 : 1, 0, 0, 0, 9, 0, 0, 0, 0])
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

function rawFlvTag(tagType: number, timestampMs: number, payload: Uint8Array): Uint8Array {
  const previousTagSize = 11 + payload.byteLength
  return concatBytes([
    new Uint8Array([tagType, ...u24(payload.byteLength), ...u24(timestampMs & 0x00ff_ffff), (timestampMs >> 24) & 0xff, 0, 0, 0]),
    payload,
    new Uint8Array([(previousTagSize >> 24) & 0xff, (previousTagSize >> 16) & 0xff, (previousTagSize >> 8) & 0xff, previousTagSize & 0xff]),
  ])
}

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
