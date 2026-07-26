import { describe, expect, it, vi } from 'vitest'

import { HttpFlvLoaderError } from '../src/loader/http-flv-loader'
import { MseUnsupportedMimeError } from '../src/mse/mime'
import { RuntimeWorker } from '../src/runtime'

import type { NormalizedRivmuxPlayerOptions, WorkerMessage } from '@rivmux/protocol'
import type { StreamChunk, StreamLoader, StreamLoaderStats } from '../src/loader/loader'
import type { RuntimeMseController, RuntimeWorkerDependencies } from '../src/runtime'
import type { CoreEvent, TransmuxCoreHost } from '../src/wasm/rivmux-transmux-wasm'

describe('RuntimeWorker', () => {
  it('emits ready after init', async () => {
    const port = new MockPort()
    const runtime = createRuntime(port)

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })

    expect(port.messages).toStrictEqual([{ type: 'ready' }])
  })

  it('reports worker runtime capability failures as terminal unsupported errors during init', async () => {
    const port = new MockPort()
    const runtime = new RuntimeWorker(port, {
      detectRuntime: () => ({
        kind: 'unsupported',
        code: 'RIVMUX_UNSUPPORTED_WORKER_MSE',
        message: 'MediaSource cannot be constructed in this worker runtime.',
        terminal: true,
      }),
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })

    expect(port.messages).toStrictEqual([
      {
        type: 'error',
        error: {
          kind: 'unsupported',
          code: 'RIVMUX_UNSUPPORTED_WORKER_MSE',
          message: 'MediaSource cannot be constructed in this worker runtime.',
          terminal: true,
        },
      },
    ])
  })

  it('rejects start before attach with a terminal structured error', async () => {
    const port = new MockPort()
    const runtime = createRuntime(port)

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

  it('starts the HTTP loader and emits network stats from transmux core output', async () => {
    const port = new MockPort()
    const loader = new MockLoader([new Uint8Array([1, 2]), new Uint8Array([3])])
    const initBytes = new Uint8Array([1, 2, 3])
    const firstMediaBytes = new Uint8Array([4, 5])
    const secondMediaBytes = new Uint8Array([6])
    const mse = new MockMseController()
    const transmuxCore = new MockTransmuxCore([
      [
        { type: 'mediaInfo', data: { container: 'flv', video: 'avc', videoCodec: 'avc1.42E01E' } },
        { type: 'initSegment', data: { track: 'video', codec: 'avc1.42E01E', timescale: 1000, bytes: initBytes } },
        { type: 'mediaSegment', data: { track: 'video', dtsStartMs: 0, dtsEndMs: 40, keyframe: true, bytes: firstMediaBytes } },
      ],
      [{ type: 'mediaSegment', data: { track: 'video', dtsStartMs: 40, dtsEndMs: 80, keyframe: false, bytes: secondMediaBytes } }],
    ])
    const runtime = createRuntime(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => transmuxCore,
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
        outputBytes: 0,
        appendQueueLength: 0,
        bufferedDuration: 1,
      }),
    })
    expect(statsMessages).toContainEqual({
      type: 'stats',
      stats: expect.objectContaining({
        bytesReceived: 2,
        currentNetworkSpeed: 2,
        outputBytes: 3,
      }),
    })
    expect(statsMessages).toContainEqual({
      type: 'stats',
      stats: expect.objectContaining({
        bytesReceived: 3,
        currentNetworkSpeed: 1,
        outputBytes: 6,
      }),
    })
    expect(mse.mediaSegments).toStrictEqual([{ track: 'video', dtsStartMs: 0, dtsEndMs: 80, keyframe: true, bytes: new Uint8Array([4, 5, 6]) }])
  })

  it('flushes a pending fMP4 media batch to MSE after 125 ms', async () => {
    vi.useFakeTimers()
    try {
      const port = new MockPort()
      const loader = new BlockingLoader()
      const mse = new MockMseController()
      const transmuxCore = new MockTransmuxCore([
        [
          { type: 'initSegment', data: { track: 'audio', codec: 'opus', timescale: 48_000, bytes: new Uint8Array([1]) } },
          { type: 'mediaSegment', data: { track: 'audio', dtsStartMs: 0, dtsEndMs: 20, keyframe: true, bytes: new Uint8Array([2, 3]) } },
        ],
      ])
      const runtime = createRuntime(port, {
        createMseController: () => mse,
        createLoader: () => loader,
        createTransmuxCore: () => transmuxCore,
      })

      await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
      await runtime.handleCommand({ type: 'attach-media-source' })
      await runtime.handleCommand({ type: 'start' })
      await loader.waitForOpen()
      await loader.waitForRead()
      loader.push(new Uint8Array([1]))
      await flushMicrotasks()

      expect(mse.initSegments).toHaveLength(1)
      expect(mse.mediaSegments).toStrictEqual([])

      await vi.advanceTimersByTimeAsync(125)
      await flushMicrotasks()

      expect(mse.mediaSegments).toStrictEqual([{ track: 'audio', dtsStartMs: 0, dtsEndMs: 20, keyframe: true, bytes: new Uint8Array([2, 3]) }])
      await runtime.handleCommand({ type: 'stop' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports unavailable transmux core as a terminal structured runtime error', async () => {
    const port = new MockPort()
    const loader = new MockLoader([new Uint8Array([1])])
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => loader,
      createTransmuxCore: () => undefined,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })

    expect(loader.opened).toBe(false)
    expect(port.messages.at(-1)).toStrictEqual({
      type: 'error',
      error: {
        kind: 'runtime',
        code: 'RIVMUX_TRANSMUX_CORE_UNAVAILABLE',
        message: 'Transmux core is not available.',
        terminal: true,
      },
    })
  })

  it('reports transmux core creation failures as terminal structured runtime errors', async () => {
    const port = new MockPort()
    const loader = new MockLoader([new Uint8Array([1])])
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => loader,
      createTransmuxCore: () => {
        throw new TypeError('WASM core failed to load.')
      },
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })

    expect(loader.opened).toBe(false)
    expect(port.messages.at(-1)).toStrictEqual({
      type: 'error',
      error: {
        kind: 'runtime',
        code: 'RIVMUX_TRANSMUX_CORE_UNAVAILABLE',
        message: 'Transmux core is not available.',
        terminal: true,
        cause: {
          name: 'TypeError',
          message: 'WASM core failed to load.',
        },
      },
    })
  })

  it('does not start a loader after stop cancels in-flight transmux core creation', async () => {
    const port = new MockPort()
    const deferredCore = createDeferred<TransmuxCoreHost>()
    const createdCore = createIdleTransmuxCore()
    const loaders: MockLoader[] = []
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => {
        const loader = new MockLoader([])
        loaders.push(loader)
        return loader
      },
      createTransmuxCore: () => deferredCore.promise,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    const startPromise = runtime.handleCommand({ type: 'start' })
    await flushMicrotasks()
    const stopPromise = runtime.handleCommand({ type: 'stop' })
    await Promise.all([startPromise, stopPromise])

    expect(loaders).toStrictEqual([])
    expect(port.messages.at(-1)).toStrictEqual({ type: 'stopped' })

    deferredCore.resolve(createdCore)
    await flushMicrotasks()
    expect(createdCore.destroyed).toBe(true)
  })

  it('does not start a loader after destroy cancels in-flight transmux core creation', async () => {
    const port = new MockPort()
    const deferredCore = createDeferred<TransmuxCoreHost>()
    const createdCore = createIdleTransmuxCore()
    const loaders: MockLoader[] = []
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => {
        const loader = new MockLoader([])
        loaders.push(loader)
        return loader
      },
      createTransmuxCore: () => deferredCore.promise,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    const startPromise = runtime.handleCommand({ type: 'start' })
    await flushMicrotasks()
    const destroyPromise = runtime.handleCommand({ type: 'destroy' })
    await Promise.all([startPromise, destroyPromise])

    expect(loaders).toStrictEqual([])
    expect(port.messages.at(-1)).toStrictEqual({ type: 'destroyed' })
    expect(port.closed).toBe(true)

    deferredCore.resolve(createdCore)
    await flushMicrotasks()
    expect(createdCore.destroyed).toBe(true)
  })

  it('does not report a fatal error when cancelled transmux core creation rejects late', async () => {
    const port = new MockPort()
    const deferredCore = createDeferred<TransmuxCoreHost>()
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createTransmuxCore: () => deferredCore.promise,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    const startPromise = runtime.handleCommand({ type: 'start' })
    await flushMicrotasks()
    const stopPromise = runtime.handleCommand({ type: 'stop' })
    await Promise.all([startPromise, stopPromise])
    deferredCore.reject(new Error('Late WASM failure.'))
    await flushMicrotasks()

    expect(port.messages.filter((message) => message.type === 'error')).toStrictEqual([])
    expect(port.messages.at(-1)).toStrictEqual({ type: 'stopped' })
  })

  it.each(['stop', 'destroy'] as const)('cancels a loader open that is still pending when %s begins', async (command) => {
    const port = new MockPort()
    const loader = new DeferredOpenLoader()
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => loader,
      createTransmuxCore: () => createIdleTransmuxCore(),
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForOpen()

    await runtime.handleCommand({ type: command })
    expect(loader.closed).toBe(true)
    expect(port.messages.at(-1)).toStrictEqual(command === 'stop' ? { type: 'stopped' } : { type: 'destroyed' })
    if (command === 'destroy') {
      expect(port.closed).toBe(true)
    }

    loader.rejectOpen(new Error('Late loader open failure.'))
    await flushMicrotasks()
    expect(port.messages.some((message) => message.type === 'error')).toBe(false)
  })

  it('ignores a late read result from a stopped loader after restart', async () => {
    const port = new MockPort()
    const firstLoader = new DeferredReadLoader()
    const secondLoader = new MockLoader([])
    const firstCore = createIdleTransmuxCore()
    const secondCore = createIdleTransmuxCore()
    let loaderIndex = 0
    let coreIndex = 0
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => (loaderIndex++ === 0 ? firstLoader : secondLoader),
      createTransmuxCore: () => (coreIndex++ === 0 ? firstCore : secondCore),
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await firstLoader.waitForRead()

    await runtime.handleCommand({ type: 'stop' })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    firstLoader.resolveRead({ bytes: new Uint8Array([1, 2, 3]), receivedAtMs: 1 })
    await flushMicrotasks()

    expect(firstLoader.closed).toBe(true)
    expect(firstCore).toMatchObject({ chunks: [] })
    expect(secondCore).toMatchObject({ chunks: [] })
    expect(port.messages.some((message) => message.type === 'error')).toBe(false)
  })

  it('waits for fatal loader cleanup before acknowledging destroy', async () => {
    const port = new MockPort()
    const loader = new DeferredCloseLoader()
    const transmuxCore = new MockTransmuxCore([[{ type: 'fatalError', data: { code: 'unsupportedVideoCodec', message: 'Unsupported video codec.' } }]])
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => loader,
      createTransmuxCore: () => transmuxCore,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForClose()

    let destroyed = false
    const destroyPromise = runtime.handleCommand({ type: 'destroy' }).then(() => {
      destroyed = true
    })
    await flushMicrotasks()
    expect(destroyed).toBe(false)
    expect(port.messages.some((message) => message.type === 'destroyed')).toBe(false)

    loader.resolveClose()
    await destroyPromise
    expect(destroyed).toBe(true)
    expect(port.messages.at(-1)).toStrictEqual({ type: 'destroyed' })
    expect(port.closed).toBe(true)
  })

  it('lets destroy cancel a pending restart queued after stop', async () => {
    const port = new MockPort()
    const deferredCore = createDeferred<TransmuxCoreHost>()
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createTransmuxCore: () => deferredCore.promise,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    const stopPromise = runtime.handleCommand({ type: 'stop' })
    const attachPromise = runtime.handleCommand({ type: 'attach-media-source' })
    const startPromise = runtime.handleCommand({ type: 'start' })
    const destroyPromise = runtime.handleCommand({ type: 'destroy' })
    await Promise.all([stopPromise, attachPromise, startPromise, destroyPromise])

    expect(port.messages.at(-1)).toStrictEqual({ type: 'destroyed' })
    expect(port.closed).toBe(true)
    expect(port.messages.some((message) => message.type === 'error')).toBe(false)
  })

  it('lets stop cancel a start blocked by MSE cleanup', async () => {
    const port = new MockPort()
    const mse = new DeferredCleanupMseController()
    const loaders: MockLoader[] = []
    const runtime = createRuntime(port, {
      createMseController: () => mse,
      createLoader: () => {
        const loader = new MockLoader([])
        loaders.push(loader)
        return loader
      },
      createTransmuxCore: () => createIdleTransmuxCore(),
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'video-state', state: { currentTime: 3, readyState: 3, playbackRate: 1, paused: false } })
    mse.armCleanup()
    const startPromise = runtime.handleCommand({ type: 'start' })
    await mse.waitForCleanup()
    const stopPromise = runtime.handleCommand({ type: 'stop' })
    await Promise.all([startPromise, stopPromise])

    expect(loaders).toStrictEqual([])
    expect(port.messages.at(-1)).toStrictEqual({ type: 'stopped' })
    expect(port.messages.some((message) => message.type === 'error')).toBe(false)
    mse.resolveCleanup()
  })

  it('lets stop cancel a video state update blocked by MSE cleanup', async () => {
    const port = new MockPort()
    const loader = new BlockingLoader()
    const mse = new DeferredCleanupMseController()
    const runtime = createRuntime(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => createIdleTransmuxCore(),
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForOpen()
    mse.armCleanup()
    const videoStatePromise = runtime.handleCommand({
      type: 'video-state',
      state: { currentTime: 3, readyState: 3, playbackRate: 1, paused: false },
    })
    await mse.waitForCleanup()
    const stopPromise = runtime.handleCommand({ type: 'stop' })
    await Promise.all([videoStatePromise, stopPromise])

    expect(loader.closed).toBe(true)
    expect(port.messages.at(-1)).toStrictEqual({ type: 'stopped' })
    expect(port.messages.some((message) => message.type === 'error')).toBe(false)
    mse.resolveCleanup()
  })

  it('destroys MSE after destroy cancels an in-flight media source attachment', async () => {
    const port = new MockPort()
    const mse = new DeferredHandleMseController()
    const runtime = createRuntime(port, {
      createMseController: () => mse,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    const attachPromise = runtime.handleCommand({ type: 'attach-media-source' })
    await flushMicrotasks()
    const destroyPromise = runtime.handleCommand({ type: 'destroy' })
    await Promise.all([attachPromise, destroyPromise])

    expect(port.messages.some((message) => message.type === 'media-source-handle')).toBe(false)
    expect(mse.destroyed).toBe(true)
    expect(port.messages.at(-1)).toStrictEqual({ type: 'destroyed' })

    mse.resolveHandle({} as MediaSourceHandle)
    await flushMicrotasks()
    expect(port.messages.some((message) => message.type === 'error')).toBe(false)
  })

  it.each(['resolve', 'reject'] as const)('lets destroy cancel a pending MSE append that later %ss', async (completion) => {
    const port = new MockPort()
    const loader = new BlockingLoader()
    const mse = new DeferredAppendMseController()
    const transmuxCore = new MockTransmuxCore([
      [{ type: 'initSegment', data: { track: 'video', codec: 'avc1.42E01E', timescale: 1000, bytes: new Uint8Array([1, 2, 3]) } }],
    ])
    const runtime = createRuntime(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => transmuxCore,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForRead()
    loader.push(new Uint8Array([1]))
    await mse.waitForAppend()

    await runtime.handleCommand({ type: 'destroy' })
    expect(port.messages.at(-1)).toStrictEqual({ type: 'destroyed' })
    expect(port.closed).toBe(true)

    const messageCount = port.messages.length
    if (completion === 'resolve') {
      mse.resolveAppend()
    } else {
      mse.rejectAppend(new Error('Late append failure.'))
    }
    await flushMicrotasks()

    expect(port.messages).toHaveLength(messageCount)
    expect(port.messages.some((message) => message.type === 'error')).toBe(false)
  })

  it('acknowledges stop without leaving the terminal error state', async () => {
    const port = new MockPort()
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createTransmuxCore: () => undefined,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await runtime.handleCommand({ type: 'stop' })
    await runtime.handleCommand({ type: 'start' })

    expect(port.messages.at(-1)).toStrictEqual({ type: 'stopped' })
    expect(port.messages.filter((message) => message.type === 'error')).toHaveLength(1)
  })

  it('emits append queue, memory-oriented, and network idle stats', async () => {
    const port = new MockPort()
    const loader = new BlockingLoader({
      bytesReceived: 10,
      currentNetworkSpeed: 5,
      startedAtMs: 1000,
      lastChunkAtMs: 1125,
    })
    const mse = new MockMseController([
      { start: 0, end: 1 },
      { start: 2, end: 4 },
    ])
    mse.appendQueueLength = 2
    mse.appendQueueBytes = 4096
    mse.sourceBufferUpdating = true
    mse.sourceBufferCount = 2
    const runtime = createRuntime(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => createIdleTransmuxCore(),
      now: () => 1250,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForOpen()
    await runtime.handleCommand({ type: 'video-state', state: { currentTime: 0.5, readyState: 3, playbackRate: 1, paused: false } })
    await runtime.handleCommand({ type: 'stop' })

    expect(port.messages).toContainEqual({
      type: 'stats',
      stats: expect.objectContaining({
        bytesReceived: 10,
        currentNetworkSpeed: 5,
        networkIdleMs: 125,
        appendQueueLength: 2,
        appendQueueBytes: 4096,
        appendQueueMaxLength: 2,
        appendQueueMaxBytes: 4096,
        sourceBufferUpdating: true,
        sourceBufferCount: 2,
        bufferedRangeCount: 2,
      }),
    })
  })

  it('feeds loader chunks into the transmux core and forwards media info', async () => {
    const port = new MockPort()
    const loader = new MockLoader([new Uint8Array([1, 2])])
    const mse = new MockMseController()
    const transmuxCore = new MockTransmuxCore([[{ type: 'mediaInfo', data: { container: 'flv', video: 'avc', videoCodec: 'avc1.42E01E' } }]])
    const runtime = createRuntime(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => transmuxCore,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForDone()

    expect(transmuxCore.chunks).toStrictEqual([new Uint8Array([1, 2])])
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
    const runtime = createRuntime(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => createIdleTransmuxCore(),
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
    const runtime = createRuntime(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => createIdleTransmuxCore(),
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
    const runtime = createRuntime(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => createIdleTransmuxCore(),
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
    const runtime = createRuntime(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => transmuxCore,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForDone()

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
    const runtime = createRuntime(port, {
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

  it('reports loader failures as terminal structured network errors', async () => {
    const port = new MockPort()
    const loader = new FailingOpenLoader(new HttpFlvLoaderError('RIVMUX_HTTP_STATUS', 'HTTP status 503.', 503))
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => loader,
      createTransmuxCore: () => createIdleTransmuxCore(),
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForDone()

    expect(loader.closed).toBe(true)
    expect(port.messages).toContainEqual({
      type: 'error',
      error: {
        kind: 'network',
        code: 'RIVMUX_HTTP_STATUS',
        message: 'HTTP Fetch loader failed.',
        terminal: true,
        cause: {
          name: 'HttpFlvLoaderError',
          message: 'HTTP status 503.',
        },
      },
    })
  })

  it('reports MSE append failures as terminal structured MSE errors and closes the loader', async () => {
    const port = new MockPort()
    const loader = new MockLoader([new Uint8Array([1])])
    const mse = new MockMseController()
    mse.appendInitError = new Error('append init failed')
    const transmuxCore = new MockTransmuxCore([
      [{ type: 'initSegment', data: { track: 'video', codec: 'avc1.42E01E', timescale: 1000, bytes: new Uint8Array([1, 2, 3]) } }],
    ])
    const runtime = createRuntime(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => transmuxCore,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForDone()

    expect(loader.closed).toBe(true)
    expect(mse.destroyed).toBe(true)
    expect(port.messages).toContainEqual({
      type: 'error',
      error: {
        kind: 'mse',
        code: 'RIVMUX_MSE_APPEND_FAILED',
        message: 'MSE append failed.',
        terminal: true,
        cause: {
          name: 'Error',
          message: 'append init failed',
        },
      },
    })
  })

  it('reports unsupported MSE codec MIME as a terminal unsupported error', async () => {
    const port = new MockPort()
    const loader = new MockLoader([new Uint8Array([1])])
    const mse = new MockMseController()
    mse.appendInitError = new MseUnsupportedMimeError('audio/mp4; codecs="opus"')
    const transmuxCore = new MockTransmuxCore([
      [{ type: 'initSegment', data: { track: 'audio', codec: 'opus', timescale: 48_000, bytes: new Uint8Array([1, 2, 3]) } }],
    ])
    const runtime = createRuntime(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => transmuxCore,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForDone()

    expect(port.messages).toContainEqual({
      type: 'error',
      error: {
        kind: 'unsupported',
        code: 'RIVMUX_UNSUPPORTED_MSE_CODEC',
        message: 'MSE does not support audio/mp4; codecs="opus".',
        terminal: true,
        cause: {
          name: 'MseUnsupportedMimeError',
          message: 'MSE does not support audio/mp4; codecs="opus".',
        },
      },
    })
  })

  it('cleans buffered ranges and retries once when MSE append exceeds quota', async () => {
    const port = new MockPort()
    const loader = new MockLoader([new Uint8Array([1])])
    const mse = new MockMseController([{ start: 0, end: 8 }])
    mse.appendMediaErrors.push(createQuotaExceededError())
    const transmuxCore = new MockTransmuxCore([
      [{ type: 'mediaSegment', data: { track: 'video', dtsStartMs: 0, dtsEndMs: 40, keyframe: true, bytes: new Uint8Array([1]) } }],
    ])
    const runtime = createRuntime(port, {
      createMseController: () => mse,
      createLoader: () => loader,
      createTransmuxCore: () => transmuxCore,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForDone()

    expect(loader.closed).toBe(true)
    expect(mse.destroyed).toBe(false)
    expect(mse.cleanupRequests).toStrictEqual([6.5])
    expect(mse.mediaSegments).toStrictEqual([{ track: 'video', dtsStartMs: 0, dtsEndMs: 40, keyframe: true, bytes: new Uint8Array([1]) }])
    expect(port.messages).toContainEqual({
      type: 'warning',
      warning: {
        code: 'RIVMUX_MSE_QUOTA_RETRY',
        message: 'MSE quota was exceeded; old buffered ranges were cleaned before retrying append.',
      },
    })
    expect(port.messages.some((message) => message.type === 'error')).toBe(false)
  })

  it('closes the loader before reporting stopped', async () => {
    const port = new MockPort()
    const loader = new BlockingLoader()
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => loader,
      createTransmuxCore: () => createIdleTransmuxCore(),
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
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => loader,
      createTransmuxCore: () => createIdleTransmuxCore(),
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
  appendQueueLength = 0
  appendQueueBytes = 0
  sourceBufferUpdating = false
  sourceBufferCount = 1
  readonly initSegments: Array<Extract<CoreEvent, { type: 'initSegment' }>['data']> = []
  readonly mediaSegments: Array<Extract<CoreEvent, { type: 'mediaSegment' }>['data']> = []
  readonly cleanupRequests: number[] = []
  readonly appendMediaErrors: Error[] = []
  appendInitError?: Error
  destroyed = false

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

  get bufferedRangeCount(): number {
    return this.bufferedRanges.length
  }

  createMediaSourceHandle(): Promise<MediaSourceHandle> {
    return Promise.resolve({} as MediaSourceHandle)
  }

  appendInitSegment(segment: Extract<CoreEvent, { type: 'initSegment' }>['data']): Promise<void> {
    if (this.appendInitError !== undefined) {
      return Promise.reject(this.appendInitError)
    }

    this.initSegments.push(segment)
    return Promise.resolve()
  }

  appendMediaSegment(segment: Extract<CoreEvent, { type: 'mediaSegment' }>['data']): Promise<void> {
    const error = this.appendMediaErrors.shift()
    if (error !== undefined) {
      return Promise.reject(error)
    }

    this.mediaSegments.push(segment)
    return Promise.resolve()
  }

  cleanupBefore(cutoff: number): Promise<void> {
    this.cleanupRequests.push(cutoff)
    return Promise.resolve()
  }

  destroy(): void {
    this.destroyed = true
  }
}

class DeferredHandleMseController extends MockMseController {
  private readonly handle = createDeferred<MediaSourceHandle>()

  override createMediaSourceHandle(): Promise<MediaSourceHandle> {
    return this.handle.promise
  }

  resolveHandle(handle: MediaSourceHandle): void {
    this.handle.resolve(handle)
  }
}

class DeferredCleanupMseController extends MockMseController {
  private readonly cleanup = createDeferred<void>()
  private armed = false
  private cleanupStarted?: () => void
  private readonly started = new Promise<void>((resolve) => {
    this.cleanupStarted = resolve
  })

  override cleanupBefore(cutoff: number): Promise<void> {
    this.cleanupRequests.push(cutoff)
    if (!this.armed) {
      return Promise.resolve()
    }
    this.cleanupStarted?.()
    return this.cleanup.promise
  }

  armCleanup(): void {
    this.armed = true
  }

  waitForCleanup(): Promise<void> {
    return this.started
  }

  resolveCleanup(): void {
    this.cleanup.resolve()
  }
}

class DeferredAppendMseController extends MockMseController {
  private readonly append = createDeferred<void>()
  private appendStarted?: () => void
  private readonly started = new Promise<void>((resolve) => {
    this.appendStarted = resolve
  })

  override appendInitSegment(segment: Extract<CoreEvent, { type: 'initSegment' }>['data']): Promise<void> {
    this.initSegments.push(segment)
    this.appendStarted?.()
    return this.append.promise
  }

  waitForAppend(): Promise<void> {
    return this.started
  }

  resolveAppend(): void {
    this.append.resolve()
  }

  rejectAppend(error: unknown): void {
    this.append.reject(error)
  }
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
  readonly stats: StreamLoaderStats
  closed = false
  paused = false
  pauseCount = 0
  resumeCount = 0
  private resolveOpen?: () => void
  private resolveRead?: (value: StreamChunk | null) => void
  private resolveReadStarted?: () => void
  private readonly opened = new Promise<void>((resolve) => {
    this.resolveOpen = resolve
  })
  private readonly readStarted = new Promise<void>((resolve) => {
    this.resolveReadStarted = resolve
  })

  constructor(stats: StreamLoaderStats = { bytesReceived: 0, currentNetworkSpeed: 0 }) {
    this.stats = stats
  }

  open(): Promise<void> {
    this.resolveOpen?.()
    return Promise.resolve()
  }

  read(): Promise<StreamChunk | null> {
    this.resolveReadStarted?.()
    this.resolveReadStarted = undefined
    return new Promise((resolve) => {
      this.resolveRead = resolve
    })
  }

  push(bytes: Uint8Array): void {
    this.stats.bytesReceived += bytes.byteLength
    this.stats.currentNetworkSpeed = bytes.byteLength
    const resolveRead = this.resolveRead
    this.resolveRead = undefined
    resolveRead?.({ bytes, receivedAtMs: this.stats.bytesReceived })
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

  waitForRead(): Promise<void> {
    return this.readStarted
  }
}

class FailingOpenLoader implements StreamLoader {
  readonly stats: StreamLoaderStats = {
    bytesReceived: 0,
    currentNetworkSpeed: 0,
  }
  closed = false
  paused = false
  private resolveDone?: () => void
  private readonly done = new Promise<void>((resolve) => {
    this.resolveDone = resolve
  })

  constructor(private readonly error: Error) {}

  open(): Promise<void> {
    return Promise.reject(this.error)
  }

  read(): Promise<StreamChunk | null> {
    return Promise.resolve(null)
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
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

class DeferredOpenLoader extends MockLoader {
  private readonly openDeferred = createDeferred<void>()
  private openStarted?: () => void
  private readonly started = new Promise<void>((resolve) => {
    this.openStarted = resolve
  })

  override open(): Promise<void> {
    this.openStarted?.()
    return this.openDeferred.promise
  }

  waitForOpen(): Promise<void> {
    return this.started
  }

  rejectOpen(error: unknown): void {
    this.openDeferred.reject(error)
  }
}

class DeferredReadLoader extends MockLoader {
  private readonly readDeferred = createDeferred<StreamChunk | null>()
  private readStarted?: () => void
  private readonly started = new Promise<void>((resolve) => {
    this.readStarted = resolve
  })

  override read(): Promise<StreamChunk | null> {
    this.readStarted?.()
    this.readStarted = undefined
    return this.readDeferred.promise
  }

  waitForRead(): Promise<void> {
    return this.started
  }

  resolveRead(chunk: StreamChunk | null): void {
    this.readDeferred.resolve(chunk)
  }
}

class DeferredCloseLoader extends MockLoader {
  private readonly closeDeferred = createDeferred<void>()
  private closeStarted?: () => void
  private readonly started = new Promise<void>((resolve) => {
    this.closeStarted = resolve
  })

  constructor() {
    super([new Uint8Array([1])])
  }

  override close(): Promise<void> {
    this.closed = true
    this.closeStarted?.()
    return this.closeDeferred.promise
  }

  waitForClose(): Promise<void> {
    return this.started
  }

  resolveClose(): void {
    this.closeDeferred.resolve()
  }
}

class MockTransmuxCore implements TransmuxCoreHost {
  readonly chunks: Uint8Array[] = []
  destroyed = false
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

  destroy(): void {
    this.destroyed = true
  }
}

function createIdleTransmuxCore(): TransmuxCoreHost {
  return new MockTransmuxCore([])
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function createRuntime(port: MockPort, dependencies: RuntimeWorkerDependencies = {}): RuntimeWorker {
  return new RuntimeWorker(port, {
    detectRuntime: () => undefined,
    ...dependencies,
  })
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

function createQuotaExceededError(): Error {
  const error = new Error('SourceBuffer quota exceeded.')
  error.name = 'QuotaExceededError'
  return error
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
