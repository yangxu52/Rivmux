import { describe, expect, it } from 'vitest'

import { mergeOptions } from '../../src/runtime/options'

import type { NormalizedRivmuxPlayerOptions } from '@rivmux/protocol'

describe('mergeOptions', () => {
  it('preserves untouched option domains and nested network fields', () => {
    const current = createOptions()

    const merged = mergeOptions(current, {
      latency: { ...current.latency, target: 1.8 },
      network: {
        ...current.network,
        headers: { Authorization: 'Bearer next' },
        retry: { ...current.network.retry, maxAttempts: 5 },
      },
    })

    expect(merged).toStrictEqual({
      ...current,
      latency: { ...current.latency, target: 1.8 },
      network: {
        ...current.network,
        headers: { Accept: 'video/x-flv', Authorization: 'Bearer next' },
        retry: { maxAttempts: 5, backoffMs: 500 },
      },
    })
    expect(current.network.headers).toStrictEqual({ Accept: 'video/x-flv', Authorization: 'Bearer old' })
  })
})

function createOptions(): NormalizedRivmuxPlayerOptions {
  return {
    playback: { autoPlay: true, muted: false },
    latency: { startupBuffer: 0.35, target: 1.2, max: 2.5, maxForwardBuffer: 4, backwardBuffer: 1.5 },
    network: {
      headers: { Accept: 'video/x-flv', Authorization: 'Bearer old' },
      credentials: 'same-origin',
      retry: { maxAttempts: 3, backoffMs: 500 },
    },
    runtime: { preferWorkerMse: true },
    diagnostics: { statsIntervalMs: 1000, debug: false },
  }
}
