import { describe, expect, it, vi } from 'vitest'

import { RivmuxPlayer } from '../src/index'

import type { WorkerMessage } from 'rivmux-protocol'
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
    expect(worker.commands[0]).toMatchObject({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv' })
    expect(worker.commands[0]?.options).toMatchObject({
      runtime: {
        wasmUrl: expect.stringMatching(/rivmux_transmux_core_bg\.wasm$/u),
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
    expect(worker.commands[2]).toStrictEqual({ type: 'start' })
    expect(video.play).toHaveBeenCalledTimes(1)

    worker.emit({ type: 'media-info', mediaInfo: { container: 'fmp4', videoCodec: 'avc1.42C01E', width: 320, height: 240 } })
    worker.emit({ type: 'stats', stats: { outputBytes: 28904, appendQueueLength: 0 } })
    expect(mediaInfo).toHaveBeenCalledWith({ container: 'fmp4', videoCodec: 'avc1.42C01E', width: 320, height: 240 })
    expect(stats).toHaveBeenCalledWith({ outputBytes: 28904, appendQueueLength: 0 })

    const stopPromise = player.stop()
    expect(worker.commands[3]).toStrictEqual({ type: 'stop' })
    worker.emit({ type: 'stopped' })
    await stopPromise
    expect(stopped).toHaveBeenCalledTimes(1)
    expect(video.srcObject).toBeNull()
    expect(video.load).toHaveBeenCalledTimes(1)

    const restartPromise = player.start()
    expect(worker.commands[4]).toStrictEqual({ type: 'attach-media-source' })
    worker.emit({ type: 'media-source-handle', handle: { id: 'restart' } as unknown as MediaSourceHandle })
    await restartPromise
    expect(worker.commands[5]).toStrictEqual({ type: 'start' })
    expect(video.srcObject).toStrictEqual({ id: 'restart' })

    const destroyPromise = player.destroy()
    expect(worker.commands[6]).toStrictEqual({ type: 'destroy' })
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
    workers[0]?.emit({ type: 'media-source-handle', handle: { id: 'a' } as unknown as MediaSourceHandle })
    workers[1]?.emit({ type: 'media-source-handle', handle: { id: 'b' } as unknown as MediaSourceHandle })
    await Promise.all([attachA, attachB])

    await players[0]?.start()

    expect(workers[0]?.commands.map((command) => command.type)).toStrictEqual(['init', 'attach-media-source', 'start'])
    expect(workers[1]?.commands.map((command) => command.type)).toStrictEqual(['init', 'attach-media-source'])
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
  return {
    autoplay: false,
    muted: false,
    srcObject: null,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    removeAttribute: vi.fn(),
    load: vi.fn(),
  } as unknown as HTMLVideoElement
}
