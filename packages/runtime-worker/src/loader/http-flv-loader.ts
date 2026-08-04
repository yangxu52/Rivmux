import type { StreamChunk, StreamLoader, StreamLoaderConfig, StreamLoaderStats } from './loader'
import type { ReconnectReason } from '@rivmux/protocol'

type LoaderState = 'idle' | 'opening' | 'open' | 'closed'
export type HttpFlvLoaderErrorPhase = 'open' | 'read'

export type HttpFlvLoaderErrorOptions = {
  phase: HttpFlvLoaderErrorPhase
  reason?: ReconnectReason
  status?: number
  cause?: unknown
}

/** Structured failure raised by one HTTP-FLV connection. */
export class HttpFlvLoaderError extends Error {
  readonly code: string
  readonly phase: HttpFlvLoaderErrorPhase
  readonly reason?: ReconnectReason
  readonly status?: number
  override readonly cause?: unknown

  constructor(code: string, message: string, options?: HttpFlvLoaderErrorOptions | number) {
    const normalizedOptions: HttpFlvLoaderErrorOptions =
      typeof options === 'number' ? { phase: 'open', reason: 'http-status', status: options } : (options ?? { phase: 'open' })
    super(message, normalizedOptions.cause === undefined ? undefined : { cause: normalizedOptions.cause })
    this.name = 'HttpFlvLoaderError'
    this.code = code
    this.phase = normalizedOptions.phase
    this.reason = normalizedOptions.reason
    this.status = normalizedOptions.status
    this.cause = normalizedOptions.cause
  }
}

export class HttpFlvLoader implements StreamLoader {
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly credentials: RequestCredentials
  private readonly readIdleTimeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private abortController?: AbortController
  private reader?: ReadableStreamDefaultReader<Uint8Array>
  private state: LoaderState = 'idle'
  private pausedState = false
  private resumeWaiters: Array<() => void> = []
  private activeReadTimeout?: PausableTimeout
  private readonly mutableStats: StreamLoaderStats = {
    bytesReceived: 0,
    currentNetworkSpeed: 0,
  }

  constructor(config: StreamLoaderConfig) {
    this.url = config.url
    this.headers = config.network.headers
    this.credentials = config.network.credentials
    this.readIdleTimeoutMs = config.network.readIdleTimeoutMs
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis)
    this.now = config.now ?? (() => performance.now())
    this.setTimer = config.setTimeout ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = config.clearTimeout ?? ((timer) => clearTimeout(timer))
  }

  get closed(): boolean {
    return this.state === 'closed'
  }

  get paused(): boolean {
    return this.pausedState
  }

  get stats(): StreamLoaderStats {
    return { ...this.mutableStats }
  }

  async open(): Promise<void> {
    if (this.state !== 'idle') {
      throw new HttpFlvLoaderError('RIVMUX_LOADER_INVALID_STATE', 'HTTP Fetch loader can only be opened once.', { phase: 'open' })
    }

    this.state = 'opening'
    this.mutableStats.startedAtMs = this.now()
    const abortController = new AbortController()
    this.abortController = abortController

    let response: Response
    try {
      const fetchRequest = Promise.resolve(
        this.fetchImpl(this.url, {
          method: 'GET',
          headers: createHeaders(this.headers),
          credentials: this.credentials,
          signal: abortController.signal,
        })
      )
      response = await raceWithAbort(fetchRequest, abortController.signal, (lateResponse) => void cancelResponseBody(lateResponse))
    } catch (cause) {
      if (this.closed || isAbortLikeError(cause)) {
        throw cause
      }
      throw new HttpFlvLoaderError('RIVMUX_HTTP_NETWORK_ERROR', 'HTTP Fetch loader failed to open the stream.', {
        phase: 'open',
        reason: 'network-error',
        cause,
      })
    }

    if (this.closed) {
      await cancelResponseBody(response)
      return
    }

    if (!response.ok) {
      await cancelResponseBody(response)
      throw new HttpFlvLoaderError('RIVMUX_HTTP_STATUS', `HTTP Fetch loader received status ${response.status} ${response.statusText}.`, {
        phase: 'open',
        reason: 'http-status',
        status: response.status,
      })
    }

    if (response.body === null) {
      throw new HttpFlvLoaderError('RIVMUX_HTTP_BODY_UNAVAILABLE', 'HTTP Fetch loader response body is unavailable.', { phase: 'open' })
    }

    const contentLength = response.headers.get('Content-Length')
    if (contentLength !== null) {
      const parsedContentLength = Number.parseInt(contentLength, 10)
      if (Number.isFinite(parsedContentLength) && parsedContentLength >= 0) {
        this.mutableStats.contentLength = parsedContentLength
      }
    }

    try {
      this.reader = response.body.getReader()
    } catch (cause) {
      await cancelResponseBody(response)
      throw new HttpFlvLoaderError('RIVMUX_HTTP_NETWORK_ERROR', 'HTTP Fetch loader could not acquire a stream reader.', {
        phase: 'open',
        reason: 'network-error',
        cause,
      })
    }
    this.state = 'open'
  }

  async read(): Promise<StreamChunk | null> {
    await this.waitUntilResumed()

    if (this.closed) {
      return null
    }

    const reader = this.reader
    const abortController = this.abortController
    if (reader === undefined || abortController === undefined) {
      if (this.closed) {
        return null
      }

      throw new HttpFlvLoaderError('RIVMUX_LOADER_NOT_OPEN', 'HTTP Fetch loader must be opened before read().', { phase: 'read' })
    }

    const timeout = new PausableTimeout({
      durationMs: this.readIdleTimeoutMs,
      now: this.now,
      setTimeout: this.setTimer,
      clearTimeout: this.clearTimer,
    })
    this.activeReadTimeout = timeout
    if (this.pausedState) {
      timeout.pause()
    }

    let result: ReadableStreamReadResult<Uint8Array>
    try {
      result = await raceWithAbort(Promise.race([reader.read(), timeout.promise]), abortController.signal)
    } catch (cause) {
      if (this.closed || isAbortLikeError(cause)) {
        return null
      }
      if (cause instanceof ReadIdleTimeoutError) {
        throw new HttpFlvLoaderError('RIVMUX_HTTP_READ_TIMEOUT', `HTTP Fetch loader received no data for ${this.readIdleTimeoutMs} ms.`, {
          phase: 'read',
          reason: 'read-timeout',
          cause,
        })
      }
      throw new HttpFlvLoaderError('RIVMUX_HTTP_READ_FAILED', 'HTTP Fetch loader failed while reading the stream.', {
        phase: 'read',
        reason: 'read-error',
        cause,
      })
    } finally {
      timeout.cancel()
      if (this.activeReadTimeout === timeout) {
        this.activeReadTimeout = undefined
      }
    }

    if (result.done) {
      releaseReader(reader)
      if (this.reader === reader) {
        this.reader = undefined
      }
      if (this.closed) {
        return null
      }
      throw new HttpFlvLoaderError('RIVMUX_HTTP_UNEXPECTED_EOF', 'HTTP Fetch loader reached an unexpected end of the live stream.', {
        phase: 'read',
        reason: 'unexpected-eof',
      })
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

  pause(): void {
    if (this.closed || this.pausedState) {
      return
    }

    this.pausedState = true
    this.activeReadTimeout?.pause()
  }

  resume(): void {
    if (!this.pausedState) {
      return
    }

    this.pausedState = false
    this.activeReadTimeout?.resume()
    this.resolveResumeWaiters()
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    this.state = 'closed'
    this.pausedState = false
    this.resolveResumeWaiters()
    this.activeReadTimeout?.cancel()
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

  private waitUntilResumed(): Promise<void> {
    if (!this.pausedState || this.closed) {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      this.resumeWaiters.push(resolve)
    })
  }

  private resolveResumeWaiters(): void {
    const waiters = this.resumeWaiters
    this.resumeWaiters = []
    for (const resolve of waiters) {
      resolve()
    }
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

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Response cancellation is best-effort while rejecting an unusable connection.
  }
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock()
  } catch {
    // A pending read can make releaseLock throw during teardown.
  }
}

function createAbortError(): DOMException {
  return new DOMException('HTTP Fetch loader was aborted.', 'AbortError')
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal, onLateValue?: (value: T) => void): Promise<T> {
  if (signal.aborted) {
    void operation.then(onLateValue, () => undefined)
    return Promise.reject(createAbortError())
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      void operation.then(onLateValue, () => undefined)
      reject(createAbortError())
    }

    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        if (settled) {
          return
        }
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) {
          return
        }
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

class ReadIdleTimeoutError extends Error {
  constructor() {
    super('HTTP Fetch loader read timed out.')
    this.name = 'ReadIdleTimeoutError'
  }
}

type PausableTimeoutOptions = {
  durationMs: number
  now: () => number
  setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
}

class PausableTimeout {
  readonly promise: Promise<never>
  private readonly now: () => number
  private readonly setTimer: PausableTimeoutOptions['setTimeout']
  private readonly clearTimer: PausableTimeoutOptions['clearTimeout']
  private reject?: (error: ReadIdleTimeoutError) => void
  private timer?: ReturnType<typeof setTimeout>
  private remainingMs: number
  private startedAtMs = 0
  private settled = false

  constructor(options: PausableTimeoutOptions) {
    this.now = options.now
    this.setTimer = options.setTimeout
    this.clearTimer = options.clearTimeout
    this.remainingMs = options.durationMs
    this.promise = new Promise<never>((_, reject) => {
      this.reject = reject
    })
    this.start()
  }

  pause(): void {
    if (this.settled || this.timer === undefined) {
      return
    }
    this.remainingMs = Math.max(0, this.remainingMs - Math.max(0, this.now() - this.startedAtMs))
    this.clearTimer(this.timer)
    this.timer = undefined
  }

  resume(): void {
    if (this.settled || this.timer !== undefined) {
      return
    }
    this.start()
  }

  cancel(): void {
    if (this.settled) {
      return
    }
    this.settled = true
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    this.reject = undefined
  }

  private start(): void {
    this.startedAtMs = this.now()
    this.timer = this.setTimer(() => {
      if (this.settled) {
        return
      }
      this.settled = true
      this.timer = undefined
      this.reject?.(new ReadIdleTimeoutError())
      this.reject = undefined
    }, this.remainingMs)
  }
}
