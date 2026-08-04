import { HttpFlvLoaderError } from './http-flv-loader'

export type RetryPolicy = {
  maxAttempts: number
  backoffMs: number
  maxBackoffMs: number
  jitterRatio: number
}

export function createRetryPolicy(input: RetryPolicy): RetryPolicy {
  return { ...input }
}

/**
 * Calculates the delay after a failed one-based connection attempt.
 * Attempt 1 is the initial connection, so its retry uses the base delay.
 */
export function getRetryDelayMs(policy: RetryPolicy, failedAttempt: number, random: () => number = Math.random): number {
  if (policy.backoffMs === 0 || policy.maxBackoffMs === 0) {
    return 0
  }

  const exponent = Math.max(0, Math.trunc(failedAttempt) - 1)
  const exponentialDelay = Math.min(policy.maxBackoffMs, policy.backoffMs * 2 ** exponent)
  const randomValue = normalizeRandom(random())
  const jitterMultiplier = 1 + (randomValue * 2 - 1) * policy.jitterRatio
  return Math.min(policy.maxBackoffMs, Math.max(0, Math.round(exponentialDelay * jitterMultiplier)))
}

export function isRecoverableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

export function isRecoverableLoaderError(cause: unknown): cause is HttpFlvLoaderError {
  if (!(cause instanceof HttpFlvLoaderError) || cause.reason === undefined) {
    return false
  }

  if (cause.reason === 'http-status') {
    return cause.status !== undefined && isRecoverableHttpStatus(cause.status)
  }

  return cause.reason === 'network-error' || cause.reason === 'read-error' || cause.reason === 'read-timeout' || cause.reason === 'unexpected-eof'
}

function normalizeRandom(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5
  }
  return Math.min(1, Math.max(0, value))
}
