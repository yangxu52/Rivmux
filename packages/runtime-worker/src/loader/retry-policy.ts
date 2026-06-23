export type RetryPolicy = {
  maxAttempts: number
  backoffMs: number
}

export function createRetryPolicy(input: Partial<RetryPolicy> | undefined): RetryPolicy {
  return {
    maxAttempts: clampInteger(input?.maxAttempts, 1),
    backoffMs: clampInteger(input?.backoffMs, 0),
  }
}

export function getRetryDelayMs(policy: RetryPolicy, attempt: number): number {
  if (policy.backoffMs === 0) {
    return 0
  }

  return policy.backoffMs * Math.max(1, attempt)
}

function clampInteger(value: number | undefined, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return minimum
  }

  return Math.max(minimum, Math.trunc(value))
}
