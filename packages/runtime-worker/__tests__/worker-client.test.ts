import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkerClient } from '../src/index'

import type { WorkerMessage } from '@rivmux/protocol'
import type { WorkerLike } from '../src/index'

describe('WorkerClient', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
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

  it.each(['media-source-handle', 'stopped', 'destroyed'] as const)('settles a pending %s request before a throwing message hook', async (type) => {
    const reportError = vi.fn()
    vi.stubGlobal('reportError', reportError)
    const worker = new MockWorker()
    const hookError = new Error(`${type} hook failed`)
    const client = new WorkerClient(worker, {
      onMessage: () => {
        throw hookError
      },
      onError: vi.fn(),
    })
    worker.emit({ type: 'worker-ready' })

    const pending =
      type === 'media-source-handle'
        ? client.waitForMediaSourceHandle({ type: 'attach-media-source' })
        : type === 'stopped'
          ? client.waitForStopped({ type: 'stop' })
          : client.waitForDestroyed({ type: 'destroy' })
    worker.emit(type === 'media-source-handle' ? { type, handle: {} as MediaSourceHandle } : { type })

    await expect(pending).resolves.toBeUndefined()
    expect(reportError).toHaveBeenCalledWith(hookError)
    client.dispose()
  })

  it('rejects pending requests before reporting a terminal error to a throwing hook', async () => {
    const reportError = vi.fn()
    vi.stubGlobal('reportError', reportError)
    const worker = new MockWorker()
    const hookError = new Error('error hook failed')
    const client = new WorkerClient(worker, {
      onMessage: () => {
        throw hookError
      },
      onError: vi.fn(),
    })
    worker.emit({ type: 'worker-ready' })
    const attach = client.waitForMediaSourceHandle({ type: 'attach-media-source' })
    const terminalError = { kind: 'network' as const, code: 'RIVMUX_HTTP_STATUS', message: 'failed', terminal: true }

    worker.emit({ type: 'error', error: terminalError })

    await expect(attach).rejects.toMatchObject(terminalError)
    expect(reportError).toHaveBeenCalledWith(hookError)
    client.dispose()
  })

  it('isolates ordinary message and fatal worker hooks', async () => {
    vi.useFakeTimers()
    const reportError = vi.fn()
    vi.stubGlobal('reportError', reportError)
    const worker = new MockWorker()
    const messageError = new Error('ordinary hook failed')
    const fatalHookError = new Error('fatal hook failed')
    const client = new WorkerClient(worker, {
      onMessage: () => {
        throw messageError
      },
      onError: () => {
        throw fatalHookError
      },
    })
    worker.emit({ type: 'worker-ready' })

    expect(() => worker.emit({ type: 'ready' })).not.toThrow()
    const stop = client.waitForStopped({ type: 'stop' })
    const rejection = expect(stop).rejects.toMatchObject({ code: 'RIVMUX_STOP_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(5_000)

    await rejection
    expect(reportError).toHaveBeenCalledWith(messageError)
    expect(reportError).toHaveBeenCalledWith(fatalHookError)
    client.dispose()
  })

  it('keeps start pending until started and clears its timeout before the hook runs', async () => {
    vi.useFakeTimers()
    const worker = new MockWorker()
    let settled = false
    const onMessage = vi.fn((message: WorkerMessage) => {
      if (message.type === 'started') {
        expect(settled).toBe(false)
      }
    })
    const client = new WorkerClient(worker, { onMessage, onError: vi.fn() })
    worker.emit({ type: 'worker-ready' })
    const started = client.waitForStarted({ type: 'start' }).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    worker.emit({ type: 'started' })
    await started
    await vi.advanceTimersByTimeAsync(5_000)

    expect(settled).toBe(true)
    expect(onMessage).toHaveBeenCalledWith({ type: 'started' })
    client.dispose()
  })

  it('settles start before a throwing started hook and rejects a concurrent start request', async () => {
    const reportError = vi.fn()
    vi.stubGlobal('reportError', reportError)
    const worker = new MockWorker()
    const hookError = new Error('started hook failed')
    const client = new WorkerClient(worker, {
      onMessage: () => {
        throw hookError
      },
      onError: vi.fn(),
    })
    worker.emit({ type: 'worker-ready' })

    const started = client.waitForStarted({ type: 'start' })
    const concurrent = client.waitForStarted({ type: 'start' })
    const concurrentRejection = expect(concurrent).rejects.toMatchObject({ code: 'RIVMUX_START_IN_PROGRESS', terminal: false })
    worker.emit({ type: 'started' })

    await expect(started).resolves.toBeUndefined()
    await concurrentRejection
    expect(reportError).toHaveBeenCalledWith(hookError)
    client.dispose()
  })

  it('times out a pending start with a fatal structured error', async () => {
    vi.useFakeTimers()
    const worker = new MockWorker()
    const onError = vi.fn()
    const client = new WorkerClient(worker, { onMessage: vi.fn(), onError })
    worker.emit({ type: 'worker-ready' })
    const started = client.waitForStarted({ type: 'start' })
    const rejection = expect(started).rejects.toMatchObject({ code: 'RIVMUX_START_TIMEOUT', terminal: true })

    await vi.advanceTimersByTimeAsync(5_000)

    await rejection
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'RIVMUX_START_TIMEOUT' }))
    client.dispose()
  })

  it('rejects a pending start with the original terminal worker error', async () => {
    const worker = new MockWorker()
    const client = createClient(worker)
    worker.emit({ type: 'worker-ready' })
    const terminalError = { kind: 'network' as const, code: 'RIVMUX_HTTP_STATUS', message: 'failed', terminal: true }
    const started = client.waitForStarted({ type: 'start' })
    const rejection = expect(started).rejects.toMatchObject(terminalError)

    worker.emit({ type: 'error', error: terminalError })

    await rejection
    client.dispose()
  })

  it.each(['stopped', 'destroyed'] as const)('cancels a pending start when worker reports %s', async (type) => {
    const worker = new MockWorker()
    const client = createClient(worker)
    worker.emit({ type: 'worker-ready' })
    const started = client.waitForStarted({ type: 'start' })
    const rejection = expect(started).rejects.toMatchObject({ code: 'RIVMUX_START_CANCELLED', terminal: false })

    worker.emit({ type })

    await rejection
    client.dispose()
  })

  it('rejects a pending start when disposed', async () => {
    const worker = new MockWorker()
    const client = createClient(worker)
    worker.emit({ type: 'worker-ready' })
    const started = client.waitForStarted({ type: 'start' })
    const rejection = expect(started).rejects.toMatchObject({ code: 'RIVMUX_WORKER_DISPOSED', terminal: true })

    client.dispose()

    await rejection
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
