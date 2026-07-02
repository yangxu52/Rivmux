import { afterEach, describe, expect, it, vi } from 'vitest'

import { RivmuxPlayer } from '../src/index'
import { MseController } from '../../runtime-worker/src/mse/mse-controller'
import { RuntimeWorker } from '../../runtime-worker/src/runtime'
import { createM1StaticFmp4Fixture, M1_VIDEO_MIME } from '../../../tests/fixtures/m1-static-fmp4'

import type { WorkerMessage } from '@rivmux/protocol'
import type { StreamChunk, StreamLoader, StreamLoaderStats } from '../../runtime-worker/src/loader/loader'
import type { RuntimeWorkerPort } from '../../runtime-worker/src/runtime'
import type { CoreEvent, TransmuxCoreHost } from '../../runtime-worker/src/wasm/rivmux-transmux-wasm'
import type { WorkerLike } from '../src/worker-client'

describe('M1 static fMP4 runtime path', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('runs RivmuxPlayer through worker-owned MSE and appends static fMP4 in order', async () => {
    const mse = installMockMse()
    const worker = new StaticFmp4Worker()
    const video = createMockVideo()
    const player = new RivmuxPlayer('fixture://m1-static-fmp4', { playback: { autoPlay: false } }, createInternals(worker))
    const mediaInfo: unknown[] = []
    const stats: unknown[] = []
    const errors: unknown[] = []
    player.on('mediaInfo', (entry) => mediaInfo.push(entry))
    player.on('stats', (entry) => stats.push(entry))
    player.on('error', (entry) => errors.push(entry))

    await player.attach(video)
    expect(video.srcObject).toBe(mse.mediaSources[0]?.handle)

    await player.start()
    await waitFor(() => mse.appendLog.length === 2)

    expect(errors).toStrictEqual([])
    expect(mediaInfo).toContainEqual({
      container: 'fmp4',
      videoCodec: 'avc1.42C01E',
      width: 320,
      height: 240,
    })
    expect(mse.sourceBuffers).toHaveLength(1)
    expect(mse.sourceBuffers[0]?.mimeType).toBe(M1_VIDEO_MIME)
    expect(mse.appendLog).toStrictEqual([
      { sourceBufferId: 1, mimeType: M1_VIDEO_MIME, boxType: 'ftyp', byteLength: 769 },
      { sourceBufferId: 1, mimeType: M1_VIDEO_MIME, boxType: 'moof', byteLength: 28135 },
    ])
    expect(stats).toContainEqual(
      expect.objectContaining({
        outputBytes: 28904,
        sourceBufferCount: 1,
      })
    )

    await player.stop()
    expect(worker.closed).toBe(false)
    expect(mse.mediaSources[0]?.removedSourceBuffers).toStrictEqual([mse.sourceBuffers[0]])
    expect(video.srcObject).toBeNull()

    await player.destroy()
    expect(worker.closed).toBe(true)
    expect(worker.terminated).toBe(true)
  })

  it('keeps two static fMP4 instances isolated across start and destroy', async () => {
    const mse = installMockMse()
    const firstWorker = new StaticFmp4Worker()
    const secondWorker = new StaticFmp4Worker()
    const firstVideo = createMockVideo()
    const secondVideo = createMockVideo()
    const firstPlayer = new RivmuxPlayer('fixture://first', { playback: { autoPlay: false } }, createInternals(firstWorker))
    const secondPlayer = new RivmuxPlayer('fixture://second', { playback: { autoPlay: false } }, createInternals(secondWorker))

    await Promise.all([firstPlayer.attach(firstVideo), secondPlayer.attach(secondVideo)])
    await Promise.all([firstPlayer.start(), secondPlayer.start()])
    await waitFor(() => mse.appendLog.length === 4)

    expect(mse.mediaSources).toHaveLength(2)
    expect(mse.sourceBuffers).toHaveLength(2)
    expect(firstVideo.srcObject).toBe(mse.mediaSources[0]?.handle)
    expect(secondVideo.srcObject).toBe(mse.mediaSources[1]?.handle)
    expect(appendedBoxTypes(mse.appendLog, 1)).toStrictEqual(['ftyp', 'moof'])
    expect(appendedBoxTypes(mse.appendLog, 2)).toStrictEqual(['ftyp', 'moof'])

    await firstPlayer.destroy()
    expect(firstWorker.closed).toBe(true)
    expect(secondWorker.closed).toBe(false)
    expect(mse.mediaSources[0]?.removedSourceBuffers).toStrictEqual([mse.sourceBuffers[0]])
    expect(mse.mediaSources[1]?.removedSourceBuffers).toStrictEqual([])

    await secondPlayer.destroy()
    expect(secondWorker.closed).toBe(true)
    expect(mse.mediaSources[1]?.removedSourceBuffers).toStrictEqual([mse.sourceBuffers[1]])
  })
})

function createInternals(worker: StaticFmp4Worker): ConstructorParameters<typeof RivmuxPlayer>[2] {
  return {
    workerFactory: () => worker,
    detectRuntime: () => undefined,
    idFactory: () => worker.id,
  }
}

class StaticFmp4Worker implements WorkerLike {
  readonly id = `m1-static-${nextWorkerId++}`
  closed = false
  terminated = false
  private readonly runtime: RuntimeWorker
  private messageListener?: EventListener
  private errorListener?: EventListener
  private workerReadyPosted = false

  constructor() {
    const port: RuntimeWorkerPort = {
      postMessage: (message) => this.emit(message),
      close: () => {
        this.closed = true
      },
    }
    this.runtime = new RuntimeWorker(port, {
      createMseController: () => new MseController(),
      createLoader: () => new SingleChunkLoader(),
      createTransmuxCore: () => new StaticFmp4Core(),
      detectRuntime: () => undefined,
      now: () => 1000,
    })
  }

  addEventListener(type: string, listener: EventListener): void {
    if (type === 'message') {
      this.messageListener = listener
      this.postWorkerReady()
      return
    }

    if (type === 'error') {
      this.errorListener = listener
    }
  }

  removeEventListener(type: string): void {
    if (type === 'message') {
      this.messageListener = undefined
      return
    }

    if (type === 'error') {
      this.errorListener = undefined
    }
  }

  postMessage(command: Parameters<WorkerLike['postMessage']>[0]): void {
    void this.runtime.handleCommand(command)
  }

  terminate(): void {
    this.terminated = true
  }

  private postWorkerReady(): void {
    if (this.workerReadyPosted) {
      return
    }

    this.workerReadyPosted = true
    queueMicrotask(() => this.emit({ type: 'worker-ready' }))
  }

  private emit(message: WorkerMessage): void {
    this.messageListener?.({ data: message } as MessageEvent<WorkerMessage>)
  }

  emitError(message: string): void {
    this.errorListener?.({ message } as ErrorEvent)
  }
}

class SingleChunkLoader implements StreamLoader {
  readonly stats: StreamLoaderStats = {
    bytesReceived: 0,
    currentNetworkSpeed: 0,
    startedAtMs: 1000,
  }
  paused = false
  private offset = 0

  open(): Promise<void> {
    return Promise.resolve()
  }

  read(): Promise<StreamChunk | null> {
    if (this.offset > 0) {
      return Promise.resolve(null)
    }

    this.offset += 1
    this.stats.bytesReceived = 1
    this.stats.currentNetworkSpeed = 1
    this.stats.lastChunkAtMs = 1000
    return Promise.resolve({ bytes: new Uint8Array([0]), receivedAtMs: 1000 })
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

class StaticFmp4Core implements TransmuxCoreHost {
  private emitted = false

  pushChunk(): CoreEvent[] {
    if (this.emitted) {
      return []
    }

    this.emitted = true
    const fixture = createM1StaticFmp4Fixture()
    return [
      {
        type: 'mediaInfo',
        data: {
          container: 'fmp4',
          videoCodec: fixture.codec,
          width: fixture.width,
          height: fixture.height,
        },
      },
      {
        type: 'initSegment',
        data: {
          track: 'video',
          codec: fixture.codec,
          timescale: 1000,
          bytes: new Uint8Array(fixture.initSegment),
        },
      },
      {
        type: 'mediaSegment',
        data: {
          track: 'video',
          dtsStartMs: 0,
          dtsEndMs: Math.round(fixture.duration * 1000),
          keyframe: true,
          bytes: new Uint8Array(fixture.mediaSegment),
        },
      },
    ]
  }

  flush(): CoreEvent[] {
    return []
  }

  reset(): void {}

  destroy(): void {}
}

function installMockMse(): MockMseRegistry {
  const registry = new MockMseRegistry()
  const MockMediaSource = createMockMediaSourceClass(registry)
  vi.stubGlobal('MediaSource', MockMediaSource)
  return registry
}

class MockMseRegistry {
  readonly mediaSources: MockMediaSourceInstance[] = []
  readonly sourceBuffers: MockSourceBuffer[] = []
  readonly appendLog: AppendLogEntry[] = []
  private nextSourceBufferId = 1

  createMediaSource(): MockMediaSourceInstance {
    const mediaSource = new MockMediaSourceInstance(this, this.mediaSources.length + 1)
    this.mediaSources.push(mediaSource)
    return mediaSource
  }

  createSourceBuffer(mimeType: string): MockSourceBuffer {
    const sourceBuffer = new MockSourceBuffer(this, this.nextSourceBufferId, mimeType)
    this.nextSourceBufferId += 1
    this.sourceBuffers.push(sourceBuffer)
    return sourceBuffer
  }
}

class MockMediaSourceInstance {
  readonly readyState = 'open'
  readonly handle: MediaSourceHandle
  readonly removedSourceBuffers: MockSourceBuffer[] = []
  duration = 0

  constructor(
    private readonly registry: MockMseRegistry,
    id: number
  ) {
    this.handle = { id: `media-source-${id}` } as unknown as MediaSourceHandle
  }

  addSourceBuffer(mimeType: string): SourceBuffer {
    return this.registry.createSourceBuffer(mimeType) as unknown as SourceBuffer
  }

  removeSourceBuffer(sourceBuffer: SourceBuffer): void {
    this.removedSourceBuffers.push(sourceBuffer as unknown as MockSourceBuffer)
  }

  addEventListener(): void {}

  removeEventListener(): void {}
}

class MockSourceBuffer {
  updating = false
  buffered = createTimeRanges([{ start: 0, end: 0.4 }])
  private readonly listeners = new Map<string, Set<EventListener>>()

  constructor(
    private readonly registry: MockMseRegistry,
    readonly id: number,
    readonly mimeType: string
  ) {}

  appendBuffer(data: ArrayBuffer): void {
    this.updating = true
    this.registry.appendLog.push({
      sourceBufferId: this.id,
      mimeType: this.mimeType,
      boxType: readBoxType(data),
      byteLength: data.byteLength,
    })
    queueMicrotask(() => this.finishUpdate())
  }

  remove(): void {
    this.updating = true
    queueMicrotask(() => this.finishUpdate())
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  private finishUpdate(): void {
    this.updating = false
    for (const listener of this.listeners.get('updateend') ?? []) {
      listener(new Event('updateend'))
    }
  }
}

type AppendLogEntry = {
  sourceBufferId: number
  mimeType: string
  boxType: string
  byteLength: number
}

function createMockMediaSourceClass(registry: MockMseRegistry): typeof MediaSource {
  return class MockMediaSource {
    static readonly canConstructInDedicatedWorker = true
    static isTypeSupported(mimeType: string): boolean {
      return mimeType === M1_VIDEO_MIME || mimeType === 'audio/mp4; codecs="mp4a.40.2"'
    }

    constructor() {
      return registry.createMediaSource() as unknown as MockMediaSource
    }
  } as unknown as typeof MediaSource
}

function createTimeRanges(ranges: readonly { start: number; end: number }[]): TimeRanges {
  return {
    length: ranges.length,
    start: (index: number) => ranges[index]?.start ?? 0,
    end: (index: number) => ranges[index]?.end ?? 0,
  }
}

function createMockVideo(): HTMLVideoElement {
  const video = {
    autoplay: false,
    muted: false,
    currentTime: 0,
    readyState: 0,
    playbackRate: 1,
    paused: true,
    srcObject: null,
    play: vi.fn(() => {
      video.paused = false
      return Promise.resolve()
    }),
    pause: vi.fn(() => {
      video.paused = true
    }),
    removeAttribute: vi.fn(),
    load: vi.fn(),
  }
  return video as unknown as HTMLVideoElement
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  throw new Error('Timed out waiting for static fMP4 runtime condition.')
}

function readBoxType(buffer: ArrayBuffer): string {
  return String.fromCharCode(...new Uint8Array(buffer, 4, 4))
}

function appendedBoxTypes(entries: readonly AppendLogEntry[], sourceBufferId: number): string[] {
  return entries.filter((entry) => entry.sourceBufferId === sourceBufferId).map((entry) => entry.boxType)
}

let nextWorkerId = 1
