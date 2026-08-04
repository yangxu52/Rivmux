import { afterEach, describe, expect, it, vi } from 'vitest'

import { RivmuxPlayer } from '../src/index'

import type { WorkerMessage } from '@rivmux/protocol'
import type { WorkerLike } from '../src/worker-client'

describe('RivmuxPlayer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('attaches, starts, stops, and destroys through an isolated worker', async () => {
    const worker = new MockWorker()
    const video = createMockVideo()
    const player = new RivmuxPlayer('https://example.test/live.flv', undefined, {
      workerFactory: () => worker,
      detectRuntime: () => undefined,
      idFactory: () => 'player-1',
    })

    const ready = vi.fn()
    const mediaInfo = vi.fn()
    const stats = vi.fn()
    const stopped = vi.fn()
    const destroyed = vi.fn()
    player.on('ready', ready)
    player.on('mediaInfo', mediaInfo)
    player.on('stats', stats)
    player.on('stopped', stopped)
    player.on('destroyed', destroyed)

    const attachPromise = player.attach(video)
    expect(worker.commands).toStrictEqual([])

    worker.emit({ type: 'worker-ready' })
    expect(worker.commands[0]).toMatchObject({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv' })
    expect(worker.commands[0]?.options).toMatchObject({
      runtime: {
        preferWorkerMse: true,
        wasmUrl: expect.any(String),
      },
    })
    expect(worker.commands[1]).toStrictEqual({ type: 'attach-media-source' })

    worker.emit({ type: 'ready' })
    worker.emit({ type: 'media-source-handle', handle: {} as MediaSourceHandle })
    await attachPromise

    expect(ready).toHaveBeenCalledTimes(1)
    expect(video.srcObject).toStrictEqual({})
    expect(video.autoplay).toBe(true)

    await player.start()
    expect(worker.commands.map((command) => command.type).slice(0, 4)).toStrictEqual(['init', 'attach-media-source', 'start', 'video-state'])
    expect(video.play).not.toHaveBeenCalled()

    worker.emit({ type: 'playback-control', action: { type: 'play', reason: 'startup-buffer-ready' } })
    await flushPromises()
    expect(video.play).toHaveBeenCalledTimes(1)
    expect(worker.commands).toContainEqual({ type: 'playback-control-result', result: { type: 'play', accepted: true } })

    worker.emit({ type: 'playback-control', action: { type: 'set-playback-rate', playbackRate: 1.05, reason: 'latency-above-target' } })
    await flushPromises()
    expect(video.playbackRate).toBe(1.05)

    worker.emit({ type: 'media-info', mediaInfo: { container: 'fmp4', videoCodec: 'avc1.42C01E', width: 320, height: 240 } })
    worker.emit({ type: 'stats', stats: { outputBytes: 28904, appendQueueLength: 0 } })
    expect(mediaInfo).toHaveBeenCalledWith({ container: 'fmp4', videoCodec: 'avc1.42C01E', width: 320, height: 240 })
    expect(stats).toHaveBeenCalledWith({ outputBytes: 28904, appendQueueLength: 0 })

    const stopPromise = player.stop()
    expect(worker.commands).toContainEqual({ type: 'stop' })
    worker.emit({ type: 'stopped' })
    await stopPromise
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(video.srcObject).toBeNull()
    expect(video.load).toHaveBeenCalledTimes(1)
    expect(video.playbackRate).toBe(1)

    const restartPromise = player.start()
    expect(worker.commands).toContainEqual({ type: 'attach-media-source' })
    worker.emit({ type: 'media-source-handle', handle: { id: 'restart' } as unknown as MediaSourceHandle })
    await restartPromise
    expect(worker.commands.filter((command) => command.type === 'start')).toHaveLength(2)
    expect(video.srcObject).toStrictEqual({ id: 'restart' })

    const destroyPromise = player.destroy()
    expect(worker.commands).toContainEqual({ type: 'destroy' })
    worker.emit({ type: 'destroyed' })
    await destroyPromise
    expect(destroyed).toHaveBeenCalledTimes(1)
    expect(worker.terminated).toBe(true)
    expect(video.srcObject).toBeNull()
    expect(video.load).toHaveBeenCalledTimes(2)
  })

  it('keeps two player instances on separate workers', async () => {
    const workers = [new MockWorker(), new MockWorker()]
    const players = workers.map(
      (worker, index) =>
        new RivmuxPlayer(`https://example.test/${index}.flv`, undefined, {
          workerFactory: () => worker,
          detectRuntime: () => undefined,
          idFactory: () => `player-${index}`,
        })
    )

    const attachA = players[0]?.attach(createMockVideo())
    const attachB = players[1]?.attach(createMockVideo())
    workers[0]?.emit({ type: 'worker-ready' })
    workers[1]?.emit({ type: 'worker-ready' })
    workers[0]?.emit({ type: 'media-source-handle', handle: { id: 'a' } as unknown as MediaSourceHandle })
    workers[1]?.emit({ type: 'media-source-handle', handle: { id: 'b' } as unknown as MediaSourceHandle })
    await Promise.all([attachA, attachB])

    await players[0]?.start()

    expect(workers[0]?.commands.map((command) => command.type).slice(0, 4)).toStrictEqual(['init', 'attach-media-source', 'start', 'video-state'])
    expect(workers[1]?.commands.map((command) => command.type)).toStrictEqual(['init', 'attach-media-source'])
  })

  it('rebinds a replacement MediaSourceHandle and forwards recovery events', async () => {
    const worker = new MockWorker()
    const player = new RivmuxPlayer('https://example.test/live.flv', undefined, {
      workerFactory: () => worker,
      detectRuntime: () => undefined,
    })
    const video = createMockVideo()
    const reconnecting = vi.fn()
    const recovered = vi.fn()
    player.on('reconnecting', reconnecting)
    player.on('recovered', recovered)

    const attach = player.attach(video)
    worker.emit({ type: 'worker-ready' })
    worker.emit({ type: 'media-source-handle', handle: { id: 'initial' } as unknown as MediaSourceHandle })
    await attach
    await player.start()

    worker.emit({ type: 'reconnecting', info: { attempt: 2, maxAttempts: 3, delayMs: 500, reason: 'read-error' } })
    worker.emit({ type: 'media-source-handle', handle: { id: 'replacement' } as unknown as MediaSourceHandle })
    worker.emit({ type: 'recovered', info: { attempt: 2, downtimeMs: 150 } })

    expect(video.pause).toHaveBeenCalledOnce()
    expect(video.srcObject).toStrictEqual({ id: 'replacement' })
    expect(reconnecting).toHaveBeenCalledWith({ attempt: 2, maxAttempts: 3, delayMs: 500, reason: 'read-error' })
    expect(recovered).toHaveBeenCalledWith({ attempt: 2, downtimeMs: 150 })
    const destroy = player.destroy()
    worker.emit({ type: 'destroyed' })
    await destroy
  })

  it('preserves an explicit WASM URL when initializing the worker', async () => {
    const worker = new MockWorker()
    const player = new RivmuxPlayer(
      'https://example.test/live.flv',
      { runtime: { wasmUrl: 'https://cdn.example.test/rivmux-transmux-core.wasm' } },
      {
        workerFactory: () => worker,
        detectRuntime: () => undefined,
      }
    )

    const attachPromise = player.attach(createMockVideo())
    worker.emit({ type: 'worker-ready' })
    expect(worker.commands[0]?.options).toMatchObject({
      runtime: { wasmUrl: 'https://cdn.example.test/rivmux-transmux-core.wasm' },
    })
    worker.emit({ type: 'media-source-handle', handle: {} as MediaSourceHandle })
    await attachPromise
  })

  it('rejects start after destroy with a structured runtime code', async () => {
    const worker = new MockWorker()
    const player = new RivmuxPlayer('https://example.test/live.flv', undefined, {
      workerFactory: () => worker,
      detectRuntime: () => undefined,
    })

    const destroyPromise = player.destroy()
    await destroyPromise

    await expect(player.start()).rejects.toMatchObject({ name: 'RIVMUX_PLAYER_DESTROYED' })
  })

  it('enters a terminal state after a fatal worker error without waiting for stop', async () => {
    const worker = new MockWorker()
    const video = createMockVideo()
    const player = new RivmuxPlayer('https://example.test/live.flv', undefined, {
      workerFactory: () => worker,
      detectRuntime: () => undefined,
    })
    const errors = vi.fn()
    player.on('error', errors)

    const attachPromise = player.attach(video)
    worker.emit({ type: 'worker-ready' })
    worker.emit({ type: 'media-source-handle', handle: {} as MediaSourceHandle })
    await attachPromise
    await player.start()

    worker.emit({
      type: 'error',
      error: {
        kind: 'network',
        code: 'RIVMUX_HTTP_STATUS',
        message: 'HTTP Fetch loader failed.',
        terminal: true,
      },
    })

    expect(errors).toHaveBeenCalledOnce()
    expect(video.srcObject).toBeNull()
    expect(video.load).toHaveBeenCalledOnce()
    await expect(player.start()).rejects.toMatchObject({ name: 'RIVMUX_HTTP_STATUS', message: 'HTTP Fetch loader failed.' })

    const commandCount = worker.commands.length
    await player.stop()
    expect(worker.commands).toHaveLength(commandCount)

    const destroyPromise = player.destroy()
    expect(worker.commands.at(-1)).toStrictEqual({ type: 'destroy' })
    worker.emit({ type: 'destroyed' })
    await destroyPromise
    expect(worker.terminated).toBe(true)
  })

  it('settles stop and destroy when their event listeners throw', async () => {
    const worker = new MockWorker()
    const video = createMockVideo()
    const player = new RivmuxPlayer('https://example.test/live.flv', undefined, {
      workerFactory: () => worker,
      detectRuntime: () => undefined,
    })
    const reported: unknown[] = []
    vi.stubGlobal('reportError', (error: unknown) => reported.push(error))
    player.on('stopped', () => {
      throw new Error('stopped listener failed')
    })
    player.on('destroyed', () => {
      throw new Error('destroyed listener failed')
    })

    const attach = player.attach(video)
    worker.emit({ type: 'worker-ready' })
    worker.emit({ type: 'media-source-handle', handle: {} as MediaSourceHandle })
    await attach
    await player.start()

    const stop = player.stop()
    worker.emit({ type: 'stopped' })
    await expect(stop).resolves.toBeUndefined()

    const destroy = player.destroy()
    worker.emit({ type: 'destroyed' })
    await expect(destroy).resolves.toBeUndefined()
    expect(worker.terminated).toBe(true)
    expect(reported).toHaveLength(2)
  })

  it('does not convert a throwing error listener into another PlayerError and still destroys cleanly', async () => {
    const worker = new MockWorker()
    const video = createMockVideo()
    const player = new RivmuxPlayer('https://example.test/live.flv', undefined, {
      workerFactory: () => worker,
      detectRuntime: () => undefined,
    })
    const listenerFailure = new Error('error listener failed')
    const reported = vi.fn()
    const followingListener = vi.fn()
    vi.stubGlobal('reportError', reported)
    player.on('error', () => {
      throw listenerFailure
    })
    player.on('error', followingListener)

    const attach = player.attach(video)
    worker.emit({ type: 'worker-ready' })
    worker.emit({ type: 'media-source-handle', handle: {} as MediaSourceHandle })
    await attach
    await player.start()
    const terminalError = {
      kind: 'network' as const,
      code: 'RIVMUX_HTTP_STATUS',
      message: 'HTTP Fetch loader failed.',
      terminal: true,
    }

    worker.emit({ type: 'error', error: terminalError })

    expect(followingListener).toHaveBeenCalledOnce()
    expect(followingListener).toHaveBeenCalledWith(terminalError)
    expect(reported).toHaveBeenCalledOnce()
    expect(reported).toHaveBeenCalledWith(listenerFailure)
    const destroy = player.destroy()
    worker.emit({ type: 'destroyed' })
    await expect(destroy).resolves.toBeUndefined()
    expect(worker.terminated).toBe(true)
    expect(video.srcObject).toBeNull()
  })

  it('finishes local destroy cleanup when the worker fails before acknowledging destroy', async () => {
    const worker = new MockWorker()
    const video = createMockVideo()
    const player = new RivmuxPlayer('https://example.test/live.flv', undefined, {
      workerFactory: () => worker,
      detectRuntime: () => undefined,
    })

    const attachPromise = player.attach(video)
    worker.emit({ type: 'worker-ready' })
    worker.emit({ type: 'media-source-handle', handle: {} as MediaSourceHandle })
    await attachPromise

    const destroyPromise = player.destroy()
    worker.emitError('Worker crashed during destroy.')
    await expect(destroyPromise).rejects.toMatchObject({ code: 'RIVMUX_WORKER_ERROR' })

    expect(worker.terminated).toBe(true)
    expect(video.srcObject).toBeNull()
    expect(video.load).toHaveBeenCalledOnce()
    await expect(player.start()).rejects.toMatchObject({ name: 'RIVMUX_PLAYER_DESTROYED' })
    await expect(player.destroy()).resolves.toBeUndefined()
  })

  it('prevents resource revival while destroy is waiting for the worker', async () => {
    const worker = new MockWorker()
    const player = new RivmuxPlayer('https://example.test/live.flv', undefined, {
      workerFactory: () => worker,
      detectRuntime: () => undefined,
    })
    const video = createMockVideo()
    const attachPromise = player.attach(video)
    worker.emit({ type: 'worker-ready' })
    worker.emit({ type: 'media-source-handle', handle: {} as MediaSourceHandle })
    await attachPromise

    const firstDestroy = player.destroy()
    const secondDestroy = player.destroy()
    await expect(player.attach(video)).rejects.toMatchObject({ name: 'RIVMUX_PLAYER_DESTROYING' })
    await expect(player.start()).rejects.toMatchObject({ name: 'RIVMUX_PLAYER_DESTROYING' })
    await expect(player.stop()).resolves.toBeUndefined()
    expect(worker.commands.filter((command) => command.type === 'destroy')).toHaveLength(1)

    worker.emit({ type: 'destroyed' })
    await Promise.all([firstDestroy, secondDestroy])
    expect(worker.terminated).toBe(true)
  })

  it('does not let a resolved attach overwrite destroying before its continuation runs', async () => {
    const worker = new MockWorker()
    const workerFactory = vi.fn(() => worker)
    const player = new RivmuxPlayer('https://example.test/live.flv', undefined, {
      workerFactory,
      detectRuntime: () => undefined,
    })
    const video = createMockVideo()

    const attachPromise = player.attach(video)
    worker.emit({ type: 'worker-ready' })
    worker.emit({ type: 'media-source-handle', handle: {} as MediaSourceHandle })
    const destroyPromise = player.destroy()
    await attachPromise

    await expect(player.attach(video)).rejects.toMatchObject({ name: 'RIVMUX_PLAYER_DESTROYING' })
    await expect(player.start()).rejects.toMatchObject({ name: 'RIVMUX_PLAYER_DESTROYING' })
    expect(workerFactory).toHaveBeenCalledOnce()

    worker.emit({ type: 'destroyed' })
    await destroyPromise
  })

  it('does not let a resolved stop overwrite destroying before its continuation runs', async () => {
    const worker = new MockWorker()
    const workerFactory = vi.fn(() => worker)
    const player = new RivmuxPlayer('https://example.test/live.flv', undefined, {
      workerFactory,
      detectRuntime: () => undefined,
    })
    const video = createMockVideo()

    const attachPromise = player.attach(video)
    worker.emit({ type: 'worker-ready' })
    worker.emit({ type: 'media-source-handle', handle: {} as MediaSourceHandle })
    await attachPromise
    await player.start()

    const stopPromise = player.stop()
    worker.emit({ type: 'stopped' })
    const destroyPromise = player.destroy()
    await stopPromise

    await expect(player.attach(video)).rejects.toMatchObject({ name: 'RIVMUX_PLAYER_DESTROYING' })
    await expect(player.start()).rejects.toMatchObject({ name: 'RIVMUX_PLAYER_DESTROYING' })
    expect(workerFactory).toHaveBeenCalledOnce()

    worker.emit({ type: 'destroyed' })
    await destroyPromise
  })

  it('preserves a terminal error when attach resolves in the same task', async () => {
    const worker = new MockWorker()
    const player = new RivmuxPlayer('https://example.test/live.flv', undefined, {
      workerFactory: () => worker,
      detectRuntime: () => undefined,
    })
    const terminalError = {
      kind: 'network' as const,
      code: 'RIVMUX_HTTP_STATUS',
      message: 'HTTP Fetch loader failed.',
      terminal: true,
    }

    const attachPromise = player.attach(createMockVideo())
    worker.emit({ type: 'worker-ready' })
    worker.emit({ type: 'media-source-handle', handle: {} as MediaSourceHandle })
    worker.emit({ type: 'error', error: terminalError })
    await attachPromise

    await expect(player.start()).rejects.toMatchObject({ name: terminalError.code, message: terminalError.message })
  })

  it('cancels a pending restart when stop begins after the attach acknowledgement', async () => {
    const worker = new MockWorker()
    const player = new RivmuxPlayer('https://example.test/live.flv', undefined, {
      workerFactory: () => worker,
      detectRuntime: () => undefined,
    })
    const video = createMockVideo()

    const attachPromise = player.attach(video)
    worker.emit({ type: 'worker-ready' })
    worker.emit({ type: 'media-source-handle', handle: {} as MediaSourceHandle })
    await attachPromise
    await player.start()
    const initialStop = player.stop()
    worker.emit({ type: 'stopped' })
    await initialStop

    const restart = player.start()
    worker.emit({ type: 'media-source-handle', handle: { id: 'restart' } as unknown as MediaSourceHandle })
    const stop = player.stop()
    const repeatedStop = player.stop()
    await expect(player.start()).rejects.toMatchObject({ name: 'RIVMUX_PLAYER_STOPPING' })
    await expect(player.attach(video)).rejects.toMatchObject({ name: 'RIVMUX_PLAYER_STOPPING' })
    await restart
    expect(worker.commands.slice(-2).map((command) => command.type)).toStrictEqual(['attach-media-source', 'stop'])

    worker.emit({ type: 'stopped' })
    await Promise.all([stop, repeatedStop])

    const nextRestart = player.start()
    worker.emit({ type: 'media-source-handle', handle: { id: 'next-restart' } as unknown as MediaSourceHandle })
    await nextRestart
    expect(worker.commands.at(-2)?.type).toBe('start')

    const destroy = player.destroy()
    worker.emit({ type: 'destroyed' })
    await destroy
  })
})

class MockWorker implements WorkerLike {
  readonly commands: Array<{ type: string; [key: string]: unknown }> = []
  terminated = false
  private messageListener?: EventListener
  private errorListener?: EventListener

  addEventListener(type: string, listener: EventListener): void {
    if (type === 'message') {
      this.messageListener = listener
    }

    if (type === 'error') {
      this.errorListener = listener
    }
  }

  removeEventListener(type: string): void {
    if (type === 'message') {
      this.messageListener = undefined
    }

    if (type === 'error') {
      this.errorListener = undefined
    }
  }

  postMessage(command: { type: string; [key: string]: unknown }): void {
    this.commands.push(command)
  }

  terminate(): void {
    this.terminated = true
  }

  emit(message: WorkerMessage): void {
    this.messageListener?.({ data: message } as MessageEvent<WorkerMessage>)
  }

  emitError(message: string): void {
    this.errorListener?.({ message } as ErrorEvent)
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

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
