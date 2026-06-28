import { describe, expect, it } from 'vitest'

import { RuntimeWorker } from '../src/runtime'

import type { NormalizedRivmuxPlayerOptions, WorkerMessage } from 'rivmux-protocol'
import type { StreamChunk, StreamLoader, StreamLoaderStats } from '../src/loader/loader'
import type { RuntimeMseController } from '../src/runtime'
import type { CoreEvent, TransmuxCoreHost } from '../src/wasm/rivmux-transmux-wasm'

describe('RuntimeWorker', () => {
  it('emits ready after init', async () => {
    const port = new MockPort()
    const runtime = new RuntimeWorker(port)

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })

    expect(port.messages).toStrictEqual([{ type: 'ready' }])
  })

  it('rejects start before attach with a terminal structured error', async () => {
    const port = new MockPort()
    const runtime = new RuntimeWorker(port)

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'start' })

    expect(port.messages.at(-1)).toStrictEqual({
      type: 'error',
      error: {
        kind: 'runtime',
        code: 'RIVMUX_WORKER_START_REQUIRES_ATTACH',
        message: 'Worker start requires an attached MediaSource.',
        terminal: true,
      },
    })
  })

  it('starts the HTTP loader and emits network stats while keeping fixture append output', async () => {
    const port = new MockPort()
    const loader = new MockLoader([new Uint8Array([1, 2]), new Uint8Array([3])])
    const runtime = new RuntimeWorker(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => loader,
      createTransmuxCore: () => undefined,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForDone()

    const statsMessages = port.messages.filter((message) => message.type === 'stats')

    expect(loader.opened).toBe(true)
    expect(loader.closed).toBe(true)
    expect(port.messages).toContainEqual({
      type: 'playback-control',
      action: { type: 'play', reason: 'startup-buffer-ready' },
    })
    expect(statsMessages).toContainEqual({
      type: 'stats',
      stats: expect.objectContaining({
        bytesReceived: 0,
        currentNetworkSpeed: 0,
        outputBytes: 28904,
        appendQueueLength: 0,
        bufferedDuration: 1,
      }),
    })
    expect(statsMessages).toContainEqual({
      type: 'stats',
      stats: expect.objectContaining({
        bytesReceived: 2,
        currentNetworkSpeed: 2,
        outputBytes: 28904,
      }),
    })
    expect(statsMessages).toContainEqual({
      type: 'stats',
      stats: expect.objectContaining({
        bytesReceived: 3,
        currentNetworkSpeed: 1,
        outputBytes: 28904,
      }),
    })
  })

  it('feeds loader chunks into the transmux core and forwards media info', async () => {
    const port = new MockPort()
    const loader = new MockLoader([new Uint8Array([1, 2])])
    const mse = new MockMseController()
    const transmuxCore = new MockTransmuxCore([[{ type: 'mediaInfo', data: { container: 'flv', video: 'avc', videoCodec: 'avc1.42E01E' } }]])
    const runtime = new RuntimeWorker(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => transmuxCore,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForDone()

    expect(transmuxCore.chunks).toStrictEqual([new Uint8Array([1, 2])])
    expect(mse.appendedFixtureCount).toBe(0)
    expect(port.messages).toContainEqual({
      type: 'media-info',
      mediaInfo: {
        container: 'flv',
        videoCodec: 'avc1.42E01E',
      },
    })
  })

  it('measures live latency and cleans old SourceBuffer ranges from video state', async () => {
    const port = new MockPort()
    const loader = new BlockingLoader()
    const mse = new MockMseController([{ start: 0, end: 6 }])
    const runtime = new RuntimeWorker(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => undefined,
      now: () => 1000,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForOpen()
    await runtime.handleCommand({
      type: 'video-state',
      state: { currentTime: 3, readyState: 3, playbackRate: 1, paused: false, droppedFrames: 2 },
    })
    await runtime.handleCommand({ type: 'stop' })

    expect(mse.cleanupRequests).toStrictEqual([1.5])
    expect(port.messages).toContainEqual({
      type: 'stats',
      stats: expect.objectContaining({
        currentTime: 3,
        liveLatency: 3,
        playbackRate: 1,
        readyState: 3,
        droppedFrames: 2,
      }),
    })
  })

  it('pauses and resumes the loader when forward buffer crosses latency bounds', async () => {
    const port = new MockPort()
    const loader = new BlockingLoader()
    const mse = new MockMseController([{ start: 0, end: 6 }])
    const runtime = new RuntimeWorker(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => undefined,
      now: () => 1000,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForOpen()
    await runtime.handleCommand({ type: 'video-state', state: { currentTime: 1, readyState: 3, playbackRate: 1, paused: false } })
    expect(loader.paused).toBe(true)

    await runtime.handleCommand({ type: 'video-state', state: { currentTime: 5, readyState: 3, playbackRate: 1, paused: false } })
    await runtime.handleCommand({ type: 'stop' })

    expect(loader.paused).toBe(false)
    expect(loader.pauseCount).toBe(1)
    expect(loader.resumeCount).toBe(1)
    expect(port.messages).toContainEqual({
      type: 'stats',
      stats: expect.objectContaining({
        loaderPaused: true,
      }),
    })
  })

  it('requests latency chasing controls without repeating seek requests inside cooldown', async () => {
    const port = new MockPort()
    const loader = new BlockingLoader()
    const mse = new MockMseController([{ start: 0, end: 6 }])
    let now = 1000
    const runtime = new RuntimeWorker(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => undefined,
      now: () => now,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForOpen()
    await runtime.handleCommand({ type: 'playback-control-result', result: { type: 'play', accepted: true } })
    await runtime.handleCommand({ type: 'video-state', state: { currentTime: 2, readyState: 3, playbackRate: 1, paused: false } })
    await runtime.handleCommand({ type: 'playback-control-result', result: { type: 'seek', accepted: true } })
    await runtime.handleCommand({ type: 'video-state', state: { currentTime: 2.1, readyState: 3, playbackRate: 1, paused: false } })
    now = 2200
    await runtime.handleCommand({ type: 'video-state', state: { currentTime: 4.4, readyState: 3, playbackRate: 1, paused: false } })
    await runtime.handleCommand({ type: 'stop' })

    expect(port.messages.filter((message) => message.type === 'playback-control')).toStrictEqual([
      { type: 'playback-control', action: { type: 'play', reason: 'startup-buffer-ready' } },
      { type: 'playback-control', action: { type: 'seek', targetTime: 4.8, reason: 'latency-max-exceeded' } },
      { type: 'playback-control', action: { type: 'set-playback-rate', playbackRate: 1.05, reason: 'latency-above-target' } },
    ])
  })

  it('appends transmux core init and media segments for each track through MSE', async () => {
    const port = new MockPort()
    const loader = new MockLoader([new Uint8Array([1, 2])])
    const mse = new MockMseController()
    const initBytes = new Uint8Array([1, 2, 3])
    const mediaBytes = new Uint8Array([4, 5])
    const audioInitBytes = new Uint8Array([6, 7])
    const audioMediaBytes = new Uint8Array([8, 9, 10])
    const transmuxCore = new MockTransmuxCore([
      [
        { type: 'initSegment', data: { track: 'video', codec: 'avc1.42E01E', timescale: 1000, bytes: initBytes } },
        { type: 'mediaSegment', data: { track: 'video', dtsStartMs: 0, dtsEndMs: 40, keyframe: true, bytes: mediaBytes } },
        { type: 'initSegment', data: { track: 'audio', codec: 'mp4a.40.2', timescale: 44_100, bytes: audioInitBytes } },
        { type: 'mediaSegment', data: { track: 'audio', dtsStartMs: 0, dtsEndMs: 23, keyframe: true, bytes: audioMediaBytes } },
      ],
    ])
    const runtime = new RuntimeWorker(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => transmuxCore,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForDone()

    expect(mse.appendedFixtureCount).toBe(0)
    expect(mse.initSegments).toStrictEqual([
      { track: 'video', codec: 'avc1.42E01E', timescale: 1000, bytes: initBytes },
      { track: 'audio', codec: 'mp4a.40.2', timescale: 44_100, bytes: audioInitBytes },
    ])
    expect(mse.mediaSegments).toStrictEqual([
      { track: 'video', dtsStartMs: 0, dtsEndMs: 40, keyframe: true, bytes: mediaBytes },
      { track: 'audio', dtsStartMs: 0, dtsEndMs: 23, keyframe: true, bytes: audioMediaBytes },
    ])
    expect(port.messages).toContainEqual({
      type: 'stats',
      stats: expect.objectContaining({
        outputBytes: 10,
      }),
    })
  })

  it('closes the loader when the transmux core emits a fatal error', async () => {
    const port = new MockPort()
    const loader = new MockLoader([new Uint8Array([1])])
    const transmuxCore = new MockTransmuxCore([[{ type: 'fatalError', data: { code: 'unsupportedVideoCodec', message: 'Unsupported video codec.' } }]])
    const runtime = new RuntimeWorker(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => loader,
      createTransmuxCore: () => transmuxCore,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForDone()

    expect(loader.closed).toBe(true)
    expect(port.messages).toContainEqual({
      type: 'error',
      error: {
        kind: 'unsupported',
        code: 'RIVMUX_CORE_UNSUPPORTED_VIDEO_CODEC',
        message: 'Unsupported video codec.',
        terminal: true,
      },
    })
  })

  it('closes the loader before reporting stopped', async () => {
    const port = new MockPort()
    const loader = new BlockingLoader()
    const runtime = new RuntimeWorker(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => loader,
      createTransmuxCore: () => undefined,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForOpen()
    await runtime.handleCommand({ type: 'stop' })

    expect(loader.closed).toBe(true)
    expect(port.messages.at(-1)).toStrictEqual({ type: 'stopped' })
  })

  it('closes the loader before reporting destroyed and closing the port', async () => {
    const port = new MockPort()
    const loader = new BlockingLoader()
    const runtime = new RuntimeWorker(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => loader,
      createTransmuxCore: () => undefined,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForOpen()
    await runtime.handleCommand({ type: 'destroy' })

    expect(loader.closed).toBe(true)
    expect(port.messages.at(-1)).toStrictEqual({ type: 'destroyed' })
    expect(port.closed).toBe(true)
  })
})

class MockPort {
  readonly messages: WorkerMessage[] = []
  closed = false

  postMessage(message: WorkerMessage): void {
    this.messages.push(message)
  }

  close(): void {
    this.closed = true
  }
}

class MockMseController implements RuntimeMseController {
  readonly appendQueueLength = 0
  readonly sourceBufferUpdating = false
  readonly initSegments: Array<Extract<CoreEvent, { type: 'initSegment' }>['data']> = []
  readonly mediaSegments: Array<Extract<CoreEvent, { type: 'mediaSegment' }>['data']> = []
  readonly cleanupRequests: number[] = []
  appendedFixtureCount = 0

  constructor(readonly bufferedRanges = [{ start: 0, end: 1 }]) {}

  get bufferedStart(): number | undefined {
    return this.bufferedRanges[0]?.start
  }

  get bufferedEnd(): number | undefined {
    const range = this.bufferedRanges[this.bufferedRanges.length - 1]
    return range?.end
  }

  get bufferedDuration(): number | undefined {
    return this.bufferedRanges.reduce((total, range) => total + range.end - range.start, 0)
  }

  createMediaSourceHandle(): Promise<MediaSourceHandle> {
    return Promise.resolve({} as MediaSourceHandle)
  }

  appendFixture(): Promise<void> {
    this.appendedFixtureCount += 1
    return Promise.resolve()
  }

  appendInitSegment(segment: Extract<CoreEvent, { type: 'initSegment' }>['data']): Promise<void> {
    this.initSegments.push(segment)
    return Promise.resolve()
  }

  appendMediaSegment(segment: Extract<CoreEvent, { type: 'mediaSegment' }>['data']): Promise<void> {
    this.mediaSegments.push(segment)
    return Promise.resolve()
  }

  cleanupBefore(cutoff: number): Promise<void> {
    this.cleanupRequests.push(cutoff)
    return Promise.resolve()
  }

  destroy(): void {}
}

class MockLoader implements StreamLoader {
  readonly stats: StreamLoaderStats = {
    bytesReceived: 0,
    currentNetworkSpeed: 0,
  }
  opened = false
  closed = false
  paused = false
  pauseCount = 0
  resumeCount = 0
  private offset = 0
  private resolveDone?: () => void
  private readonly done = new Promise<void>((resolve) => {
    this.resolveDone = resolve
  })

  constructor(private readonly chunks: Uint8Array[]) {}

  open(): Promise<void> {
    this.opened = true
    return Promise.resolve()
  }

  read(): Promise<StreamChunk | null> {
    const chunk = this.chunks[this.offset]
    this.offset += 1

    if (chunk === undefined) {
      return Promise.resolve(null)
    }

    this.stats.bytesReceived += chunk.byteLength
    this.stats.currentNetworkSpeed = chunk.byteLength

    return Promise.resolve({ bytes: chunk, receivedAtMs: this.offset })
  }

  pause(): void {
    this.paused = true
    this.pauseCount += 1
  }

  resume(): void {
    this.paused = false
    this.resumeCount += 1
  }

  close(): Promise<void> {
    this.closed = true
    this.resolveDone?.()
    return Promise.resolve()
  }

  waitForDone(): Promise<void> {
    return this.done
  }
}

class BlockingLoader implements StreamLoader {
  readonly stats: StreamLoaderStats = {
    bytesReceived: 0,
    currentNetworkSpeed: 0,
  }
  closed = false
  paused = false
  pauseCount = 0
  resumeCount = 0
  private resolveOpen?: () => void
  private resolveRead?: (value: StreamChunk | null) => void
  private readonly opened = new Promise<void>((resolve) => {
    this.resolveOpen = resolve
  })

  open(): Promise<void> {
    this.resolveOpen?.()
    return Promise.resolve()
  }

  read(): Promise<StreamChunk | null> {
    return new Promise((resolve) => {
      this.resolveRead = resolve
    })
  }

  pause(): void {
    this.paused = true
    this.pauseCount += 1
  }

  resume(): void {
    this.paused = false
    this.resumeCount += 1
    this.resolveRead?.(null)
  }

  close(): Promise<void> {
    this.closed = true
    this.resolveRead?.(null)
    return Promise.resolve()
  }

  waitForOpen(): Promise<void> {
    return this.opened
  }
}

class MockTransmuxCore implements TransmuxCoreHost {
  readonly chunks: Uint8Array[] = []
  private offset = 0

  constructor(private readonly eventBatches: CoreEvent[][]) {}

  pushChunk(chunk: Uint8Array): CoreEvent[] {
    this.chunks.push(chunk)
    const events = this.eventBatches[this.offset] ?? []
    this.offset += 1
    return events
  }

  flush(): CoreEvent[] {
    return []
  }

  reset(): void {}

  destroy(): void {}
}

function createOptions(): NormalizedRivmuxPlayerOptions {
  return {
    playback: { autoPlay: true, muted: false },
    latency: { startupBuffer: 0.35, target: 1.2, max: 2.5, maxForwardBuffer: 4, backwardBuffer: 1.5 },
    network: { headers: {}, credentials: 'same-origin', retry: { maxAttempts: 3, backoffMs: 500 } },
    runtime: { preferWorkerMse: true },
    diagnostics: { statsIntervalMs: 1000, debug: false },
  }
}
