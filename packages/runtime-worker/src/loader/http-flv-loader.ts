import { createRetryPolicy, getRetryDelayMs } from './retry-policy'

import type { StreamChunk, StreamLoader, StreamLoaderConfig, StreamLoaderStats } from './loader'

type LoaderState = 'idle' | 'opening' | 'open' | 'closed'

export class HttpFlvLoaderError extends Error {
  readonly code: string
  readonly status?: number

  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = 'HttpFlvLoaderError'
    this.code = code
    this.status = status
  }
}

export class HttpFlvLoader implements StreamLoader {
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly credentials: RequestCredentials
  private readonly retry = createRetryPolicy(undefined)
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private abortController?: AbortController
  private reader?: ReadableStreamDefaultReader<Uint8Array>
  private state: LoaderState = 'idle'
  private readonly mutableStats: StreamLoaderStats = {
    bytesReceived: 0,
    currentNetworkSpeed: 0,
  }

  constructor(config: StreamLoaderConfig) {
    this.url = config.url
    this.headers = config.network.headers
    this.credentials = config.network.credentials
    this.retry = createRetryPolicy(config.network.retry)
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis)
    this.now = config.now ?? (() => performance.now())
    this.sleep = config.sleep ?? wait
  }

  get closed(): boolean {
    return this.state === 'closed'
  }

  get stats(): StreamLoaderStats {
    return { ...this.mutableStats }
  }

  async open(): Promise<void> {
    if (this.state !== 'idle') {
      throw new HttpFlvLoaderError('RIVMUX_LOADER_INVALID_STATE', 'HTTP Fetch loader can only be opened once.')
    }

    this.state = 'opening'
    this.mutableStats.startedAtMs = this.now()

    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      this.abortController = new AbortController()

      try {
        await this.openAttempt()
        return
      } catch (cause) {
        if (this.closed || isAbortLikeError(cause) || attempt >= this.retry.maxAttempts) {
          throw cause
        }

        await this.sleep(getRetryDelayMs(this.retry, attempt), this.abortController.signal)
      }
    }
  }

  async read(): Promise<StreamChunk | null> {
    const reader = this.reader
    if (reader === undefined) {
      if (this.closed) {
        return null
      }

      throw new HttpFlvLoaderError('RIVMUX_LOADER_NOT_OPEN', 'HTTP Fetch loader must be opened before read().')
    }

    const result = await reader.read()
    if (result.done) {
      releaseReader(reader)
      if (this.reader === reader) {
        this.reader = undefined
      }
      return null
    }

    const bytes = result.value
    const receivedAtMs = this.now()
    const previousChunkAtMs = this.mutableStats.lastChunkAtMs ?? this.mutableStats.startedAtMs ?? receivedAtMs
    const elapsedSeconds = Math.max((receivedAtMs - previousChunkAtMs) / 1000, 0)

    this.mutableStats.bytesReceived += bytes.byteLength
    this.mutableStats.currentNetworkSpeed = elapsedSeconds === 0 ? bytes.byteLength : bytes.byteLength / elapsedSeconds
    this.mutableStats.lastChunkAtMs = receivedAtMs

    return { bytes, receivedAtMs }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    this.state = 'closed'
    this.abortController?.abort()

    const reader = this.reader
    this.reader = undefined
    if (reader === undefined) {
      return
    }

    try {
      await reader.cancel()
    } catch {
      // Cancellation errors are expected while aborting an in-flight stream.
    } finally {
      releaseReader(reader)
    }
  }

  private async openAttempt(): Promise<void> {
    const abortController = this.abortController
    if (abortController === undefined) {
      throw new HttpFlvLoaderError('RIVMUX_LOADER_INVALID_STATE', 'HTTP Fetch loader abort controller is missing.')
    }

    const response = await this.fetchImpl(this.url, {
      method: 'GET',
      headers: createHeaders(this.headers),
      credentials: this.credentials,
      signal: abortController.signal,
    })

    if (this.closed) {
      await response.body?.cancel()
      return
    }

    if (!response.ok) {
      await response.body?.cancel()
      throw new HttpFlvLoaderError('RIVMUX_HTTP_STATUS', `HTTP Fetch loader received status ${response.status} ${response.statusText}.`, response.status)
    }

    if (response.body === null) {
      throw new HttpFlvLoaderError('RIVMUX_HTTP_BODY_UNAVAILABLE', 'HTTP Fetch loader response body is unavailable.')
    }

    const contentLength = response.headers.get('Content-Length')
    if (contentLength !== null) {
      const parsedContentLength = Number.parseInt(contentLength, 10)
      if (Number.isFinite(parsedContentLength) && parsedContentLength >= 0) {
        this.mutableStats.contentLength = parsedContentLength
      }
    }

    this.reader = response.body.getReader()
    this.state = 'open'
  }
}

export function isAbortLikeError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError'
}

function createHeaders(headers: Record<string, string>): Headers {
  const result = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    result.append(key, value)
  }
  return result
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock()
  } catch {
    // A pending read can make releaseLock throw during teardown.
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }

  if (signal.aborted) {
    return Promise.reject(createAbortError())
  }

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      reject(createAbortError())
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function createAbortError(): DOMException {
  return new DOMException('HTTP Fetch loader was aborted.', 'AbortError')
}
