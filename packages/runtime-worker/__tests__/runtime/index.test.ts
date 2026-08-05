import { describe, expect, it, vi } from 'vitest'

import { HttpFlvLoaderError } from '../../src/loader/http-flv-loader'
import { MseUnsupportedMimeError } from '../../src/mse/mime'
import { RuntimeWorker } from '../../src/runtime'

import type { NormalizedRivmuxPlayerOptions, WorkerMessage } from '@rivmux/protocol'
import type { StreamChunk, StreamLoader, StreamLoaderStats } from '../../src/loader/loader'
import type { RuntimeMseController, RuntimeWorkerDependencies } from '../../src/runtime'
import type { CoreEvent, TransmuxCoreHost } from '../../src/wasm/rivmux-transmux-wasm'

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
    expect(port.messages).toContainEqual({ type: 'started' })
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

  it('does not retry rejected startup playback and requests it once again after stop and restart', async () => {
    const port = new MockPort()
    const firstLoader = new BlockingLoader()
    const secondLoader = new BlockingLoader()
    const loaders = [firstLoader, secondLoader]
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => loaders.shift() as StreamLoader,
      createTransmuxCore: () => createIdleTransmuxCore(),
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await firstLoader.waitForOpen()

    const rejection = {
      type: 'play' as const,
      accepted: false as const,
      error: { name: 'NotAllowedError', message: 'Playback requires a user gesture.' },
    }
    await runtime.handleCommand({ type: 'playback-control-result', result: rejection })
    await runtime.handleCommand({
      type: 'video-state',
      state: { currentTime: 0, readyState: 3, playbackRate: 1, paused: true },
    })

    expect(startupPlayRequests(port)).toHaveLength(1)
    expect(port.messages.some((message) => message.type === 'warning' || message.type === 'error')).toBe(false)

    await runtime.handleCommand({ type: 'stop' })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await secondLoader.waitForOpen()
    await runtime.handleCommand({ type: 'playback-control-result', result: rejection })
    await runtime.handleCommand({
      type: 'video-state',
      state: { currentTime: 0, readyState: 3, playbackRate: 1, paused: true },
    })

    expect(startupPlayRequests(port)).toHaveLength(2)
    expect(port.messages.some((message) => message.type === 'warning' || message.type === 'error')).toBe(false)
    await runtime.handleCommand({ type: 'stop' })
  })

  it('acknowledges start after scheduling loader consumption without waiting for the network or media', async () => {
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

    expect(port.messages.at(-1)).toStrictEqual({ type: 'started' })
    expect(port.messages.some((message) => message.type === 'media-info')).toBe(false)
    expect(port.messages.some((message) => message.type === 'error')).toBe(false)

    await runtime.handleCommand({ type: 'stop' })
    loader.rejectOpen(new Error('Late loader open failure.'))
    await flushMicrotasks()
  })

  it('acknowledges repeated start without creating another Core or Loader', async () => {
    const port = new MockPort()
    const loader = new BlockingLoader()
    const createLoader = vi.fn(() => loader)
    const createTransmuxCore = vi.fn(() => createIdleTransmuxCore())
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createLoader,
      createTransmuxCore,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await runtime.handleCommand({ type: 'start' })

    expect(port.messages.filter((message) => message.type === 'started')).toStrictEqual([{ type: 'started' }, { type: 'started' }])
    expect(createTransmuxCore).toHaveBeenCalledOnce()
    expect(createLoader).toHaveBeenCalledOnce()

    await runtime.handleCommand({ type: 'stop' })
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
    expect(port.messages.some((message) => message.type === 'started')).toBe(false)
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
    expect(port.messages.some((message) => message.type === 'started')).toBe(false)
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
    expect(port.messages.some((message) => message.type === 'started')).toBe(false)
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
    expect(port.messages.some((message) => message.type === 'started')).toBe(false)
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

  it('waits for natural loader cleanup before acknowledging destroy', async () => {
    const port = new MockPort()
    const loader = new DeferredCloseLoader()
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => loader,
      createTransmuxCore: () => createIdleTransmuxCore(),
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
    expect(port.messages.at(-1)).toStrictEqual({ type: 'destroyed' })
    expect(port.closed).toBe(true)
  })

  it('suppresses a loader failure when stop begins during pending cleanup', async () => {
    const port = new MockPort()
    const loader = new DeferredCloseFailingOpenLoader(new HttpFlvLoaderError('RIVMUX_HTTP_STATUS', 'HTTP status 401.', 401))
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => loader,
      createTransmuxCore: () => createIdleTransmuxCore(),
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForClose()

    const stopPromise = runtime.handleCommand({ type: 'stop' })
    await flushMicrotasks()
    expect(port.messages.some((message) => message.type === 'stopped')).toBe(false)

    loader.resolveClose()
    await stopPromise
    expect(port.messages.at(-1)).toStrictEqual({ type: 'stopped' })
    expect(port.messages.some((message) => message.type === 'error')).toBe(false)
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

  it('cancels pending latency actions when a terminal append error occurs', async () => {
    const port = new MockPort()
    const loader = new BlockingLoader()
    const mse = new DeferredCleanupMseController([{ start: 0, end: 8 }])
    mse.appendInitError = new Error('append init failed')
    const transmuxCore = new MockTransmuxCore([
      [{ type: 'initSegment', data: { track: 'video', codec: 'avc1.42E01E', timescale: 1000, bytes: new Uint8Array([1]) } }],
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
    await runtime.handleCommand({ type: 'playback-control-result', result: { type: 'play', accepted: true } })
    mse.armCleanup()

    const videoStatePromise = runtime.handleCommand({
      type: 'video-state',
      state: { currentTime: 3, readyState: 3, playbackRate: 1, paused: false },
    })
    await mse.waitForCleanup()
    const messageCountBeforeFailure = port.messages.length
    loader.push(new Uint8Array([1]))
    await flushMicrotasks()

    await videoStatePromise
    const messagesAfterFailure = port.messages.slice(messageCountBeforeFailure)
    expect(messagesAfterFailure).toContainEqual({
      type: 'error',
      error: expect.objectContaining({ code: 'RIVMUX_MSE_APPEND_FAILED', terminal: true }),
    })
    expect(messagesAfterFailure.some((message) => message.type === 'playback-control')).toBe(false)
    mse.resolveCleanup()
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
    const loader = new FailingOpenLoader(new HttpFlvLoaderError('RIVMUX_HTTP_STATUS', 'HTTP status 401.', 401))
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
          message: 'HTTP status 401.',
        },
      },
    })
  })

  it('reports a natural loader close failure without an unhandled rejection', async () => {
    const port = new MockPort()
    const loader = new RejectingCloseLoader()
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => loader,
      createTransmuxCore: () => createIdleTransmuxCore(),
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForClose()
    await flushMicrotasks()

    expect(port.messages).toContainEqual({
      type: 'error',
      error: expect.objectContaining({
        kind: 'network',
        code: 'RIVMUX_HTTP_LOADER_CLOSE_FAILED',
        message: 'HTTP Fetch loader failed to close.',
        terminal: true,
      }),
    })
  })

  it('preserves the original loader failure when cleanup also fails', async () => {
    const port = new MockPort()
    const loader = new RejectingCloseFailingOpenLoader(new HttpFlvLoaderError('RIVMUX_HTTP_STATUS', 'HTTP status 401.', 401))
    const runtime = createRuntime(port, {
      createMseController: () => new MockMseController(),
      createLoader: () => loader,
      createTransmuxCore: () => createIdleTransmuxCore(),
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForClose()
    await flushMicrotasks()

    const errors = port.messages.filter((message) => message.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toStrictEqual({
      type: 'error',
      error: {
        kind: 'network',
        code: 'RIVMUX_HTTP_STATUS',
        message: 'HTTP Fetch loader failed.',
        terminal: true,
        cause: {
          name: 'HttpFlvLoaderError',
          message: 'HTTP status 401.',
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

  it('reports unsupported HEVC/AAC MSE MIME and cleans the failed session', async () => {
    const port = new MockPort()
    const loader = new MockLoader([new Uint8Array([1])])
    const mse = new MockMseController()
    mse.appendInitError = new MseUnsupportedMimeError('video/mp4; codecs="hvc1.1.6.L30.90, mp4a.40.2"')
    const transmuxCore = new MockTransmuxCore([
      [
        {
          type: 'initSegment',
          data: {
            track: 'muxed',
            codec: 'hvc1.1.6.L30.90, mp4a.40.2',
            timescale: 1000,
            bytes: new Uint8Array([1, 2, 3]),
          },
        },
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

    expect(loader.closed).toBe(true)
    expect(mse.destroyed).toBe(true)
    expect(port.messages).toContainEqual({
      type: 'error',
      error: {
        kind: 'unsupported',
        code: 'RIVMUX_UNSUPPORTED_MSE_CODEC',
        message: 'MSE does not support video/mp4; codecs="hvc1.1.6.L30.90, mp4a.40.2".',
        terminal: true,
        cause: {
          name: 'MseUnsupportedMimeError',
          message: 'MSE does not support video/mp4; codecs="hvc1.1.6.L30.90, mp4a.40.2".',
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

  it('rebuilds Loader, Core, and MSE and reports recovered only after the first media append', async () => {
    const port = new MockPort()
    const firstLoader = new FailingOpenLoader(
      new HttpFlvLoaderError('RIVMUX_HTTP_STATUS', 'HTTP status 503.', {
        phase: 'open',
        reason: 'http-status',
        status: 503,
      })
    )
    const replacementLoader = new BlockingLoader()
    const nextCycleLoader = new BlockingLoader()
    const loaders: StreamLoader[] = [firstLoader, replacementLoader, nextCycleLoader]
    const firstMse = new MockMseController()
    const replacementMse = new MockMseController()
    const mses = [firstMse, replacementMse, new MockMseController()]
    const firstCore = createIdleTransmuxCore()
    const replacementCore = new MockTransmuxCore([mediaEvents()])
    const cores = [firstCore, replacementCore, createIdleTransmuxCore()]
    let currentTime = 100
    const runtime = createRuntime(port, {
      createLoader: () => loaders.shift() as StreamLoader,
      createMseController: () => mses.shift() as MockMseController,
      createTransmuxCore: () => cores.shift(),
      sleep: () => Promise.resolve(),
      random: () => 0.5,
      now: () => (currentTime += 10),
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await flushMicrotasks()

    expect(port.messages).toContainEqual({
      type: 'reconnecting',
      info: { attempt: 2, maxAttempts: 3, delayMs: 500, reason: 'http-status' },
    })
    expect(port.messages.filter((message) => message.type === 'media-source-handle')).toHaveLength(2)
    expect(port.messages.some((message) => message.type === 'recovered')).toBe(false)

    await replacementLoader.waitForRead()
    replacementLoader.push(new Uint8Array([1]))
    await flushMicrotasks(20)

    expect(firstLoader.closed).toBe(true)
    expect(firstMse.destroyed).toBe(true)
    expect(firstCore).toMatchObject({ destroyed: true })
    expect(replacementMse.destroyed).toBe(false)
    const recovered = port.messages.find((message) => message.type === 'recovered')
    expect(recovered).toMatchObject({ type: 'recovered', info: { attempt: 2 } })
    expect(recovered?.info.downtimeMs).toBeGreaterThanOrEqual(0)
    expect(startupPlayRequests(port)).toHaveLength(2)

    await waitForPendingRead(replacementLoader)
    replacementLoader.fail(new HttpFlvLoaderError('RIVMUX_HTTP_READ_FAILED', 'Read failed.', { phase: 'read', reason: 'read-error' }))
    await flushMicrotasks(20)
    expect(port.messages.filter((message) => message.type === 'reconnecting').map((message) => message.info.attempt)).toStrictEqual([2, 2])
    await runtime.handleCommand({ type: 'destroy' })
  })

  it('emits one exhausted error after all recoverable connection attempts fail', async () => {
    const port = new MockPort()
    const loaders = Array.from(
      { length: 3 },
      () => new FailingOpenLoader(new HttpFlvLoaderError('RIVMUX_HTTP_STATUS', 'HTTP status 503.', { phase: 'open', reason: 'http-status', status: 503 }))
    )
    const runtime = createRuntime(port, {
      createLoader: () => loaders.shift() as StreamLoader,
      createMseController: () => new MockMseController(),
      createTransmuxCore: () => createIdleTransmuxCore(),
      sleep: () => Promise.resolve(),
      random: () => 0.5,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await flushMicrotasks(30)

    expect(port.messages.filter((message) => message.type === 'reconnecting').map((message) => message.info.attempt)).toStrictEqual([2, 3])
    const errors = port.messages.filter((message) => message.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ error: { code: 'RIVMUX_RECONNECT_EXHAUSTED', terminal: true } })
    await runtime.handleCommand({ type: 'destroy' })
  })

  it('does not reconnect an unauthorized HTTP response', async () => {
    const port = new MockPort()
    const loader = new FailingOpenLoader(
      new HttpFlvLoaderError('RIVMUX_HTTP_STATUS', 'HTTP status 401.', { phase: 'open', reason: 'http-status', status: 401 })
    )
    const runtime = createRuntime(port, {
      createLoader: () => loader,
      createMseController: () => new MockMseController(),
      createTransmuxCore: () => createIdleTransmuxCore(),
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await loader.waitForDone()

    expect(port.messages.some((message) => message.type === 'reconnecting')).toBe(false)
    expect(port.messages.filter((message) => message.type === 'error')).toHaveLength(1)
  })

  it.each(['stop', 'destroy'] as const)('cancels reconnect backoff when %s begins', async (command) => {
    const port = new MockPort()
    const delay = createAbortAwareDelay()
    let loaderCount = 0
    const runtime = createRuntime(port, {
      createLoader: () => {
        loaderCount += 1
        return new FailingOpenLoader(new HttpFlvLoaderError('RIVMUX_HTTP_STATUS', 'HTTP status 503.', { phase: 'open', reason: 'http-status', status: 503 }))
      },
      createMseController: () => new MockMseController(),
      createTransmuxCore: () => createIdleTransmuxCore(),
      sleep: delay.sleep,
      random: () => 0.5,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await delay.started
    await runtime.handleCommand({ type: command })

    expect(loaderCount).toBe(1)
    expect(delay.aborted).toBe(true)
    expect(port.messages.at(-1)).toMatchObject({ type: command === 'stop' ? 'stopped' : 'destroyed' })
  })

  it('starts a fresh recovery cycle after stop and restart', async () => {
    const port = new MockPort()
    const runtime = createRuntime(port, {
      createLoader: () =>
        new FailingOpenLoader(new HttpFlvLoaderError('RIVMUX_HTTP_STATUS', 'HTTP status 503.', { phase: 'open', reason: 'http-status', status: 503 })),
      createMseController: () => new MockMseController(),
      createTransmuxCore: () => createIdleTransmuxCore(),
      sleep: (_delayMs, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted.', 'AbortError')), { once: true })
        }),
      random: () => 0.5,
    })

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await flushMicrotasks()
    await runtime.handleCommand({ type: 'stop' })

    await runtime.handleCommand({ type: 'attach-media-source' })
    await runtime.handleCommand({ type: 'start' })
    await flushMicrotasks()

    expect(port.messages.filter((message) => message.type === 'reconnecting').map((message) => message.info.attempt)).toStrictEqual([2, 2])
    await runtime.handleCommand({ type: 'destroy' })
  })
})

function mediaEvents(): CoreEvent[] {
  return [
    { type: 'initSegment', data: { track: 'video', codec: 'avc1.42E01E', timescale: 1000, bytes: new Uint8Array([1]) } },
    { type: 'mediaSegment', data: { track: 'video', dtsStartMs: 0, dtsEndMs: 40, keyframe: true, bytes: new Uint8Array(512 * 1024) } },
  ]
}

function startupPlayRequests(port: MockPort): WorkerMessage[] {
  return port.messages.filter(
    (message) => message.type === 'playback-control' && message.action.type === 'play' && message.action.reason === 'startup-buffer-ready'
  )
}

function createAbortAwareDelay(): {
  sleep: (delayMs: number, signal: AbortSignal) => Promise<void>
  started: Promise<void>
  readonly aborted: boolean
} {
  let notifyStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  let aborted = false
  return {
    sleep: (_delayMs, signal) => {
      notifyStarted?.()
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(new DOMException('Aborted.', 'AbortError'))
          },
          { once: true }
        )
      })
    },
    started,
    get aborted() {
      return aborted
    },
  }
}

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

  constructor(bufferedRanges?: Array<{ start: number; end: number }>) {
    super(bufferedRanges)
  }

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
  private rejectRead?: (cause: unknown) => void
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

  get reading(): boolean {
    return this.rejectRead !== undefined
  }

  open(): Promise<void> {
    this.resolveOpen?.()
    return Promise.resolve()
  }

  read(): Promise<StreamChunk | null> {
    this.resolveReadStarted?.()
    this.resolveReadStarted = undefined
    return new Promise((resolve, reject) => {
      this.resolveRead = resolve
      this.rejectRead = reject
    })
  }

  push(bytes: Uint8Array): void {
    this.stats.bytesReceived += bytes.byteLength
    this.stats.currentNetworkSpeed = bytes.byteLength
    const resolveRead = this.resolveRead
    this.resolveRead = undefined
    this.rejectRead = undefined
    resolveRead?.({ bytes, receivedAtMs: this.stats.bytesReceived })
  }

  fail(cause: unknown): void {
    const rejectRead = this.rejectRead
    this.resolveRead = undefined
    this.rejectRead = undefined
    rejectRead?.(cause)
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

class DeferredCloseFailingOpenLoader extends FailingOpenLoader {
  private readonly closeDeferred = createDeferred<void>()
  private closeStarted?: () => void
  private readonly started = new Promise<void>((resolve) => {
    this.closeStarted = resolve
  })

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

class RejectingCloseLoader extends MockLoader {
  private closeStarted?: () => void
  private readonly started = new Promise<void>((resolve) => {
    this.closeStarted = resolve
  })

  constructor() {
    super([])
  }

  override close(): Promise<void> {
    this.closed = true
    this.closeStarted?.()
    return Promise.reject(new Error('loader close failed'))
  }

  waitForClose(): Promise<void> {
    return this.started
  }
}

class RejectingCloseFailingOpenLoader extends FailingOpenLoader {
  private closeStarted?: () => void
  private readonly started = new Promise<void>((resolve) => {
    this.closeStarted = resolve
  })

  override close(): Promise<void> {
    this.closed = true
    this.closeStarted?.()
    return Promise.reject(new Error('loader close failed'))
  }

  waitForClose(): Promise<void> {
    return this.started
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

async function flushMicrotasks(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

async function waitForPendingRead(loader: BlockingLoader): Promise<void> {
  for (let index = 0; index < 100 && !loader.reading; index += 1) {
    await Promise.resolve()
  }
  expect(loader.reading).toBe(true)
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
    network: {
      headers: {},
      credentials: 'same-origin',
      readIdleTimeoutMs: 10_000,
      retry: { maxAttempts: 3, backoffMs: 500, maxBackoffMs: 8_000, jitterRatio: 0.2 },
    },
    runtime: { preferWorkerMse: true },
    diagnostics: { statsIntervalMs: 1000, debug: false },
  }
}
