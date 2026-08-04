import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HttpFlvLoader, HttpFlvLoaderError } from '../src/loader/http-flv-loader'

import type { NormalizedNetworkOptions } from '@rivmux/protocol'

describe('HttpFlvLoader', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens one fetch stream and reports read stats', async () => {
    const reader = new MockReader([new Uint8Array([1, 2, 3]), new Uint8Array([4])])
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(createResponse({ body: new MockReadableStream(reader), contentLength: '4' })))
    const loader = createLoader({ reader, fetch: fetchMock })

    await loader.open()
    vi.setSystemTime(1_100)
    const first = await loader.read()
    vi.setSystemTime(1_200)
    const second = await loader.read()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/live.flv', {
      method: 'GET',
      headers: expect.any(Headers),
      credentials: 'include',
      signal: expect.any(AbortSignal),
    })
    expect(first?.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(second?.bytes).toEqual(new Uint8Array([4]))
    expect(loader.stats).toMatchObject({
      bytesReceived: 4,
      currentNetworkSpeed: 10,
      contentLength: 4,
    })
  })

  it('performs only one fetch attempt and wraps an open network failure', async () => {
    const networkError = new TypeError('fetch failed')
    const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(networkError))
    const loader = createLoader({ fetch: fetchMock })

    await expect(loader.open()).rejects.toMatchObject({
      code: 'RIVMUX_HTTP_NETWORK_ERROR',
      phase: 'open',
      reason: 'network-error',
      cause: networkError,
    } satisfies Partial<HttpFlvLoaderError>)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-ok HTTP response with status metadata', async () => {
    const body = new MockReadableStream(new MockReader([]))
    const loader = createLoader({
      fetch: () => Promise.resolve(createResponse({ ok: false, status: 503, statusText: 'Service Unavailable', body })),
    })

    await expect(loader.open()).rejects.toMatchObject({
      code: 'RIVMUX_HTTP_STATUS',
      phase: 'open',
      reason: 'http-status',
      status: 503,
    } satisfies Partial<HttpFlvLoaderError>)
    expect(body.cancel).toHaveBeenCalledTimes(1)
  })

  it('rejects a response without a readable body as a non-recoverable open failure', async () => {
    const loader = createLoader({ fetch: () => Promise.resolve(createResponse({ body: null })) })

    await expect(loader.open()).rejects.toMatchObject({
      code: 'RIVMUX_HTTP_BODY_UNAVAILABLE',
      phase: 'open',
      reason: undefined,
    } satisfies Partial<HttpFlvLoaderError>)
  })

  it('wraps reader failures with read-error metadata', async () => {
    const readError = new TypeError('stream failed')
    const reader = new DeferredReader()
    const loader = createLoader({ reader })

    await loader.open()
    const reading = loader.read()
    reader.reject(readError)

    await expect(reading).rejects.toMatchObject({
      code: 'RIVMUX_HTTP_READ_FAILED',
      phase: 'read',
      reason: 'read-error',
      cause: readError,
    } satisfies Partial<HttpFlvLoaderError>)
  })

  it('reports the first stream EOF as unexpected', async () => {
    const reader = new MockReader([])
    const loader = createLoader({ reader })

    await loader.open()

    await expect(loader.read()).rejects.toMatchObject({
      code: 'RIVMUX_HTTP_UNEXPECTED_EOF',
      phase: 'read',
      reason: 'unexpected-eof',
    } satisfies Partial<HttpFlvLoaderError>)
    expect(reader.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('times out an active read with structured metadata', async () => {
    const reader = new DeferredReader()
    const loader = createLoader({ reader, readIdleTimeoutMs: 1_000 })

    await loader.open()
    const reading = loader.read()
    const expectation = expect(reading).rejects.toMatchObject({
      code: 'RIVMUX_HTTP_READ_TIMEOUT',
      phase: 'read',
      reason: 'read-timeout',
    } satisfies Partial<HttpFlvLoaderError>)
    await vi.advanceTimersByTimeAsync(1_000)

    await expectation
  })

  it('does not count paused time toward an in-flight read timeout', async () => {
    const reader = new DeferredReader()
    const loader = createLoader({ reader, readIdleTimeoutMs: 1_000 })

    await loader.open()
    const reading = loader.read()
    await vi.advanceTimersByTimeAsync(400)
    loader.pause()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(vi.getTimerCount()).toBe(0)

    loader.resume()
    await vi.advanceTimersByTimeAsync(599)
    let settled = false
    const settlement = reading.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(reading).rejects.toMatchObject({ reason: 'read-timeout' })
    await settlement
  })

  it('defers a new read while paused without starting a timeout', async () => {
    const reader = new DeferredReader()
    const loader = createLoader({ reader, readIdleTimeoutMs: 1_000 })

    await loader.open()
    loader.pause()
    const reading = loader.read()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(reader.read).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    loader.resume()
    await Promise.resolve()
    expect(reader.read).toHaveBeenCalledTimes(1)
    reader.resolve(new Uint8Array([9]))
    await expect(reading).resolves.toMatchObject({ bytes: new Uint8Array([9]) })
  })

  it('close cancels and releases a pending read immediately', async () => {
    const reader = new DeferredReader()
    const loader = createLoader({ reader })

    await loader.open()
    const reading = loader.read()
    await Promise.resolve()
    await loader.close()

    await expect(reading).resolves.toBeNull()
    expect(reader.cancel).toHaveBeenCalledTimes(1)
    expect(reader.releaseLock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('close cancels a pending fetch even when the fetch implementation ignores its signal', async () => {
    const response = createDeferred<Response>()
    const loader = createLoader({ fetch: () => response.promise })

    const opening = loader.open()
    await Promise.resolve()
    await loader.close()

    await expect(opening).rejects.toMatchObject({ name: 'AbortError' })

    const lateBody = new MockReadableStream(new MockReader([]))
    response.resolve(createResponse({ body: lateBody }))
    await Promise.resolve()
    await Promise.resolve()
    expect(lateBody.cancel).toHaveBeenCalledTimes(1)
  })
})

class MockReader implements ReadableStreamDefaultReader<Uint8Array> {
  readonly closed: Promise<undefined> = Promise.resolve(undefined)
  readonly cancel = vi.fn(() => Promise.resolve())
  readonly releaseLock = vi.fn()
  readonly read = vi.fn((): Promise<ReadableStreamReadResult<Uint8Array>> => {
    const chunk = this.chunks[this.offset]
    this.offset += 1
    return Promise.resolve(chunk === undefined ? { done: true, value: undefined } : { done: false, value: chunk })
  })
  private offset = 0

  constructor(private readonly chunks: Uint8Array[]) {}
}

class DeferredReader implements ReadableStreamDefaultReader<Uint8Array> {
  readonly closed: Promise<undefined> = Promise.resolve(undefined)
  readonly cancel = vi.fn(() => Promise.resolve())
  readonly releaseLock = vi.fn()
  readonly read = vi.fn(() => this.result.promise)
  private readonly result = createDeferred<ReadableStreamReadResult<Uint8Array>>()

  resolve(bytes: Uint8Array): void {
    this.result.resolve({ done: false, value: bytes })
  }

  reject(error: unknown): void {
    this.result.reject(error)
  }
}

class MockReadableStream implements Pick<ReadableStream<Uint8Array>, 'cancel' | 'getReader'> {
  readonly cancel = vi.fn(() => Promise.resolve())

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  getReader(): ReadableStreamDefaultReader<Uint8Array> {
    return this.reader
  }
}

function createLoader(input: { reader?: ReadableStreamDefaultReader<Uint8Array>; fetch?: typeof fetch; readIdleTimeoutMs?: number }): HttpFlvLoader {
  const reader = input.reader ?? new MockReader([])
  return new HttpFlvLoader({
    url: 'https://example.test/live.flv',
    network: createNetworkOptions(input.readIdleTimeoutMs),
    fetch: input.fetch ?? (() => Promise.resolve(createResponse({ body: new MockReadableStream(reader) }))),
    now: () => Date.now(),
  })
}

function createNetworkOptions(readIdleTimeoutMs = 10_000): NormalizedNetworkOptions {
  return {
    headers: { 'X-Test': '1' },
    credentials: 'include',
    readIdleTimeoutMs,
    retry: { maxAttempts: 3, backoffMs: 500, maxBackoffMs: 8_000, jitterRatio: 0.2 },
  }
}

function createResponse(input: {
  ok?: boolean
  status?: number
  statusText?: string
  body?: Pick<ReadableStream<Uint8Array>, 'cancel' | 'getReader'> | null
  contentLength?: string
}): Response {
  return {
    ok: input.ok ?? true,
    status: input.status ?? 200,
    statusText: input.statusText ?? 'OK',
    body: input.body === undefined ? null : (input.body as ReadableStream<Uint8Array> | null),
    headers: new Headers(input.contentLength === undefined ? undefined : { 'Content-Length': input.contentLength }),
  } as Response
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
