import { describe, expect, it } from 'vitest'

import { getRetryDelayMs, isRecoverableHttpStatus, isRecoverableLoaderError } from '../src/loader/retry-policy'
import { HttpFlvLoaderError } from '../src/loader/http-flv-loader'

import type { RetryPolicy } from '../src/loader/retry-policy'

const policy: RetryPolicy = {
  maxAttempts: 6,
  backoffMs: 500,
  maxBackoffMs: 4_000,
  jitterRatio: 0.2,
}

describe('retry policy', () => {
  it('uses exponential backoff with a maximum delay', () => {
    expect([1, 2, 3, 4, 5].map((attempt) => getRetryDelayMs(policy, attempt, () => 0.5))).toStrictEqual([500, 1_000, 2_000, 4_000, 4_000])
  })

  it('applies deterministic symmetric jitter and clamps the final delay', () => {
    expect(getRetryDelayMs(policy, 1, () => 0)).toBe(400)
    expect(getRetryDelayMs(policy, 1, () => 0.5)).toBe(500)
    expect(getRetryDelayMs(policy, 1, () => 1)).toBe(600)
    expect(getRetryDelayMs(policy, 4, () => 1)).toBe(4_000)
  })

  it('only treats 408, 429, and 5xx HTTP responses as recoverable', () => {
    expect(isRecoverableHttpStatus(408)).toBe(true)
    expect(isRecoverableHttpStatus(429)).toBe(true)
    expect(isRecoverableHttpStatus(500)).toBe(true)
    expect(isRecoverableHttpStatus(599)).toBe(true)
    expect(isRecoverableHttpStatus(401)).toBe(false)
    expect(isRecoverableHttpStatus(403)).toBe(false)
    expect(isRecoverableHttpStatus(404)).toBe(false)
    expect(isRecoverableHttpStatus(600)).toBe(false)
  })

  it('classifies loader failures by structured reason and HTTP status', () => {
    expect(loaderError('network-error')).toSatisfy(isRecoverableLoaderError)
    expect(loaderError('read-error', 'read')).toSatisfy(isRecoverableLoaderError)
    expect(loaderError('read-timeout', 'read')).toSatisfy(isRecoverableLoaderError)
    expect(loaderError('unexpected-eof', 'read')).toSatisfy(isRecoverableLoaderError)
    expect(httpStatusError(503)).toSatisfy(isRecoverableLoaderError)
    expect(isRecoverableLoaderError(httpStatusError(401))).toBe(false)
    expect(isRecoverableLoaderError(new HttpFlvLoaderError('RIVMUX_HTTP_BODY_UNAVAILABLE', 'no body', { phase: 'open' }))).toBe(false)
    expect(isRecoverableLoaderError(new Error('unknown'))).toBe(false)
  })
})

function loaderError(reason: 'network-error' | 'read-error' | 'read-timeout' | 'unexpected-eof', phase: 'open' | 'read' = 'open') {
  return new HttpFlvLoaderError('TEST', 'test failure', { phase, reason })
}

function httpStatusError(status: number): HttpFlvLoaderError {
  return new HttpFlvLoaderError('RIVMUX_HTTP_STATUS', 'HTTP failure', { phase: 'open', reason: 'http-status', status })
}
