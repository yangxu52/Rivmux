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
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForDone()

    const statsMessages = port.messages.filter((message) => message.type === 'stats')

    expect(loader.opened).toBe(true)
    expect(loader.closed).toBe(true)
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
  readonly bufferedStart = 0
  readonly bufferedEnd = 1
  readonly bufferedDuration = 1
  readonly initSegments: Array<Extract<CoreEvent, { type: 'initSegment' }>['data']> = []
  readonly mediaSegments: Array<Extract<CoreEvent, { type: 'mediaSegment' }>['data']> = []
  appendedFixtureCount = 0

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

  destroy(): void {}
}

class MockLoader implements StreamLoader {
  readonly stats: StreamLoaderStats = {
    bytesReceived: 0,
    currentNetworkSpeed: 0,
  }
  opened = false
  closed = false
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
