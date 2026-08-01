import { describe, expect, it, vi } from 'vitest'

import { raceLifecycleOperation } from '../../src/runtime/lifecycle'

describe('raceLifecycleOperation', () => {
  it('returns an operation value before cancellation', async () => {
    const controller = new AbortController()

    await expect(raceLifecycleOperation(Promise.resolve('ready'), controller.signal)).resolves.toStrictEqual({
      cancelled: false,
      value: 'ready',
    })
  })

  it('returns cancelled immediately for an aborted lifecycle', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(raceLifecycleOperation(Promise.resolve('late'), controller.signal)).resolves.toStrictEqual({ cancelled: true })
  })

  it('cleans up a value that resolves after cancellation', async () => {
    const controller = new AbortController()
    const operation = createDeferred<string>()
    const onLateValue = vi.fn()
    const result = raceLifecycleOperation(operation.promise, controller.signal, onLateValue)

    controller.abort()
    await expect(result).resolves.toStrictEqual({ cancelled: true })

    operation.resolve('late')
    await flushMicrotasks()
    expect(onLateValue).toHaveBeenCalledOnce()
    expect(onLateValue).toHaveBeenCalledWith('late')
  })

  it('absorbs a rejection that arrives after cancellation', async () => {
    const controller = new AbortController()
    const operation = createDeferred<string>()
    const result = raceLifecycleOperation(operation.promise, controller.signal)

    controller.abort()
    await expect(result).resolves.toStrictEqual({ cancelled: true })

    operation.reject(new Error('late failure'))
    await flushMicrotasks()
  })

  it('preserves a rejection that arrives before cancellation', async () => {
    const controller = new AbortController()

    await expect(raceLifecycleOperation(Promise.reject(new Error('active failure')), controller.signal)).rejects.toThrow('active failure')
  })
})

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (cause: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
