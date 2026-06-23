import { describe, expect, it } from 'vitest'

import { RuntimeWorker } from '../src/runtime'

import type { NormalizedRivmuxPlayerOptions, WorkerMessage } from 'rivmux-protocol'
import type { StreamChunk, StreamLoader, StreamLoaderStats } from '../src/loader/loader'
import type { RuntimeMseController } from '../src/runtime'

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
    expect(statsMessages).toEqual([
      {
        type: 'stats',
        stats: expect.objectContaining({
          bytesReceived: 0,
          currentNetworkSpeed: 0,
          outputBytes: 28904,
          appendQueueLength: 0,
          bufferedDuration: 1,
        }),
      },
      {
        type: 'stats',
        stats: expect.objectContaining({
          bytesReceived: 2,
          currentNetworkSpeed: 2,
          outputBytes: 28904,
        }),
      },
      {
        type: 'stats',
        stats: expect.objectContaining({
          bytesReceived: 3,
          currentNetworkSpeed: 1,
          outputBytes: 28904,
        }),
      },
    ])
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

  createMediaSourceHandle(): Promise<MediaSourceHandle> {
    return Promise.resolve({} as MediaSourceHandle)
  }

  appendFixture(): Promise<void> {
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

function createOptions(): NormalizedRivmuxPlayerOptions {
  return {
    playback: { autoPlay: true, muted: false },
    latency: { startupBuffer: 0.35, target: 1.2, max: 2.5, maxForwardBuffer: 4, backwardBuffer: 1.5 },
    network: { headers: {}, credentials: 'same-origin', retry: { maxAttempts: 3, backoffMs: 500 } },
    runtime: { preferWorkerMse: true },
    diagnostics: { statsIntervalMs: 1000, debug: false },
  }
}
