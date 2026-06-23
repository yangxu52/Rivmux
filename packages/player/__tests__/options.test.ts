import { describe, expect, it } from 'vitest'

import { normalizePlayerOptions } from '../src/index'

describe('normalizePlayerOptions', () => {
  it('fills domain defaults without mutating user values', () => {
    const options = normalizePlayerOptions({
      playback: { autoPlay: false },
      latency: { target: 1.5 },
      network: {
        headers: { Authorization: 'Bearer test' },
        retry: { maxAttempts: 5 },
      },
      diagnostics: { debug: true },
    })

    expect(options.playback).toStrictEqual({ autoPlay: false, muted: false })
    expect(options.latency.target).toBe(1.5)
    expect(options.latency.startupBuffer).toBe(0.35)
    expect(options.network.headers).toStrictEqual({ Authorization: 'Bearer test' })
    expect(options.network.retry).toStrictEqual({ maxAttempts: 5, backoffMs: 500 })
    expect(options.diagnostics).toStrictEqual({ statsIntervalMs: 1000, debug: true })
  })
})
