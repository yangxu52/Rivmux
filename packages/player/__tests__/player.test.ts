import { describe, expect, it, vi } from 'vitest'

import { RivmuxPlayer } from '../src/index'

import type { WorkerMessage } from '@rivmux/protocol'
import type { WorkerLike } from '../src/worker-client'

describe('RivmuxPlayer', () => {
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

function flushPromises(): Promise<void> {
  return Promise.resolve()
}
