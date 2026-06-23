import { describe, expect, it, vi } from 'vitest'

import { HttpFlvLoader, HttpFlvLoaderError } from '../src/loader/http-flv-loader'

import type { NormalizedNetworkOptions } from 'rivmux-protocol'

describe('HttpFlvLoader', () => {
  it('opens a fetch stream and reports read stats', async () => {
    const reader = new MockReader([new Uint8Array([1, 2, 3]), new Uint8Array([4])])
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(createResponse({ body: new MockReadableStream(reader), contentLength: '4' })))
    const nowValues = [1000, 1100, 1200, 1300]
    const loader = new HttpFlvLoader({
      url: 'https://example.test/live.flv',
      network: createNetworkOptions(),
      fetch: fetchMock,
      now: () => nowValues.shift() ?? 1300,
    })

    await loader.open()
    const first = await loader.read()
    const second = await loader.read()
    const done = await loader.read()

    expect(fetchMock).toHaveBeenCalledWith('https://example.test/live.flv', {
      method: 'GET',
      headers: expect.any(Headers),
      credentials: 'include',
      signal: expect.any(AbortSignal),
    })
    expect(first?.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(second?.bytes).toEqual(new Uint8Array([4]))
    expect(done).toBeNull()
    expect(reader.releaseLock).toHaveBeenCalledTimes(1)
    expect(loader.stats).toMatchObject({
      bytesReceived: 4,
      currentNetworkSpeed: 10,
      contentLength: 4,
    })
  })

  it('aborts, cancels, and releases the reader on close', async () => {
    const reader = new MockReader([new Uint8Array([1])])
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return Promise.resolve(createResponse({ body: new MockReadableStream(reader) }))
    })
    const loader = new HttpFlvLoader({
      url: 'https://example.test/live.flv',
      network: createNetworkOptions(),
      fetch: fetchMock,
      now: () => 1,
    })

    await loader.open()
    await loader.close()
    await loader.close()

    expect(loader.closed).toBe(true)
    expect(reader.cancel).toHaveBeenCalledTimes(1)
    expect(reader.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('rejects non-ok HTTP status with a structured loader error', async () => {
    const loader = new HttpFlvLoader({
      url: 'https://example.test/live.flv',
      network: createNetworkOptions({ maxAttempts: 1, backoffMs: 0 }),
      fetch: () => Promise.resolve(createResponse({ ok: false, status: 503, statusText: 'Service Unavailable' })),
      now: () => 1,
    })

    await expect(loader.open()).rejects.toMatchObject({
      name: 'HttpFlvLoaderError',
      code: 'RIVMUX_HTTP_STATUS',
      status: 503,
    } satisfies Partial<HttpFlvLoaderError>)
  })

  it('rejects a response without ReadableStream body', async () => {
    const loader = new HttpFlvLoader({
      url: 'https://example.test/live.flv',
      network: createNetworkOptions({ maxAttempts: 1, backoffMs: 0 }),
      fetch: () => Promise.resolve(createResponse({ body: null })),
      now: () => 1,
    })

    await expect(loader.open()).rejects.toMatchObject({
      name: 'HttpFlvLoaderError',
      code: 'RIVMUX_HTTP_BODY_UNAVAILABLE',
    } satisfies Partial<HttpFlvLoaderError>)
  })
})

class MockReader implements ReadableStreamDefaultReader<Uint8Array> {
  readonly closed: Promise<undefined> = Promise.resolve(undefined)
  readonly cancel = vi.fn(() => Promise.resolve())
  readonly releaseLock = vi.fn()
  private offset = 0

  constructor(private readonly chunks: Uint8Array[]) {}

  read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    const chunk = this.chunks[this.offset]
    this.offset += 1

    return Promise.resolve(chunk === undefined ? { done: true, value: undefined } : { done: false, value: chunk })
  }
}

class MockReadableStream implements Pick<ReadableStream<Uint8Array>, 'cancel' | 'getReader'> {
  readonly cancel = vi.fn(() => Promise.resolve())

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  getReader(): ReadableStreamDefaultReader<Uint8Array> {
    return this.reader
  }
}

function createNetworkOptions(retry: NormalizedNetworkOptions['retry'] = { maxAttempts: 3, backoffMs: 0 }): NormalizedNetworkOptions {
  return {
    headers: { 'X-Test': '1' },
    credentials: 'include',
    retry,
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
