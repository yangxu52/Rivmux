import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkerClient } from '../src/index'

import type { WorkerMessage } from '@rivmux/protocol'
import type { WorkerLike } from '../src/index'

describe('WorkerClient', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels a pending attachment when stop completes', async () => {
    const worker = new MockWorker()
    const client = createClient(worker)
    worker.emit({ type: 'worker-ready' })

    const attachPromise = client.waitForMediaSourceHandle({ type: 'attach-media-source' })
    const stopPromise = client.waitForStopped({ type: 'stop' })
    worker.emit({ type: 'stopped' })

    await expect(attachPromise).rejects.toMatchObject({ code: 'RIVMUX_ATTACH_CANCELLED', terminal: false })
    await expect(stopPromise).resolves.toBeUndefined()
    const nextAttachPromise = client.waitForMediaSourceHandle({ type: 'attach-media-source' })
    worker.emit({ type: 'media-source-handle', handle: {} as MediaSourceHandle })
    await expect(nextAttachPromise).resolves.toBeUndefined()
    client.dispose()
  })

  it('resolves destroy and cancels other pending lifecycle requests', async () => {
    const worker = new MockWorker()
    const client = createClient(worker)
    worker.emit({ type: 'worker-ready' })

    const attachPromise = client.waitForMediaSourceHandle({ type: 'attach-media-source' })
    const stopPromise = client.waitForStopped({ type: 'stop' })
    const destroyPromise = client.waitForDestroyed({ type: 'destroy' })
    worker.emit({ type: 'destroyed' })

    await expect(destroyPromise).resolves.toBeUndefined()
    await expect(attachPromise).rejects.toMatchObject({ code: 'RIVMUX_ATTACH_CANCELLED' })
    await expect(stopPromise).rejects.toMatchObject({ code: 'RIVMUX_STOP_CANCELLED' })
    client.dispose()
  })

  it('reports request timeouts through the fatal error hook', async () => {
    vi.useFakeTimers()
    const worker = new MockWorker()
    const onError = vi.fn()
    const client = new WorkerClient(worker, { onMessage: vi.fn(), onError })
    worker.emit({ type: 'worker-ready' })

    const stopPromise = client.waitForStopped({ type: 'stop' })
    const stopRejection = expect(stopPromise).rejects.toMatchObject({ code: 'RIVMUX_STOP_TIMEOUT', terminal: true })
    await vi.advanceTimersByTimeAsync(5_000)

    await stopRejection
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'RIVMUX_STOP_TIMEOUT', terminal: true }))
    client.dispose()
  })
})

function createClient(worker: MockWorker): WorkerClient {
  return new WorkerClient(worker, { onMessage: vi.fn(), onError: vi.fn() })
}

class MockWorker implements WorkerLike {
  private messageListener?: EventListener
  private errorListener?: EventListener

  addEventListener(type: string, listener: EventListener): void {
    if (type === 'message') this.messageListener = listener
    if (type === 'error') this.errorListener = listener
  }

  removeEventListener(type: string): void {
    if (type === 'message') this.messageListener = undefined
    if (type === 'error') this.errorListener = undefined
  }

  postMessage(): void {}

  terminate(): void {}

  emit(message: WorkerMessage): void {
    this.messageListener?.({ data: message } as MessageEvent<WorkerMessage>)
  }
}
