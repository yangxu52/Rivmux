import { describe, expect, it } from 'vitest'

import { normalizePlayerOptions } from '../src/options'

import type { RivmuxPlayerOptions } from '../src/index'

describe('normalizePlayerOptions', () => {
  it('fills domain defaults without mutating user values', () => {
    const options = normalizePlayerOptions({
      playback: { autoPlay: false },
      latency: { target: 1.5 },
      network: {
        headers: { Authorization: 'Bearer test' },
        retry: { maxAttempts: 5 },
      },
      diagnostics: { statsIntervalMs: 1500 },
    })

    expect(options.playback).toStrictEqual({ autoPlay: false, muted: false })
    expect(options.latency.target).toBe(1.5)
    expect(options.latency.startupBuffer).toBe(0.35)
    expect(options.network.headers).toStrictEqual({ Authorization: 'Bearer test' })
    expect(options.network).toStrictEqual({
      headers: { Authorization: 'Bearer test' },
      credentials: 'same-origin',
      readIdleTimeoutMs: 10_000,
      retry: { maxAttempts: 5, backoffMs: 500, maxBackoffMs: 8_000, jitterRatio: 0.2 },
    })
    expect(options.runtime).toStrictEqual({})
    expect(options.diagnostics).toStrictEqual({ statsIntervalMs: 1500 })
  })

  it('keeps explicit runtime asset overrides', () => {
    const options = normalizePlayerOptions({
      runtime: {
        workerUrl: '/assets/rivmux-runtime-worker.js',
        wasmUrl: '/assets/custom-core.wasm',
      },
    })

    expect(options.runtime).toStrictEqual({
      workerUrl: '/assets/rivmux-runtime-worker.js',
      wasmUrl: '/assets/custom-core.wasm',
    })
  })

  it('rejects invalid latency configuration before worker initialization', () => {
    expectOptionError({ latency: { startupBuffer: Number.NaN } }, 'RIVMUX_INVALID_LATENCY_OPTION')
    expectOptionError({ latency: { target: 0 } }, 'RIVMUX_INVALID_LATENCY_OPTION')
    expectOptionError({ latency: { backwardBuffer: -1 } }, 'RIVMUX_INVALID_LATENCY_OPTION')
    expectOptionError({ latency: { target: 2, max: 1.5 } }, 'RIVMUX_INVALID_LATENCY_OPTION')
    expectOptionError({ latency: { target: 2, maxForwardBuffer: 1.5 } }, 'RIVMUX_INVALID_LATENCY_OPTION')
  })

  it('normalizes explicit network recovery options', () => {
    const options = normalizePlayerOptions({
      network: {
        readIdleTimeoutMs: 2_500,
        retry: { maxAttempts: 4, backoffMs: 250, maxBackoffMs: 4_000, jitterRatio: 0.5 },
      },
    })

    expect(options.network).toMatchObject({
      readIdleTimeoutMs: 2_500,
      retry: { maxAttempts: 4, backoffMs: 250, maxBackoffMs: 4_000, jitterRatio: 0.5 },
    })
  })

  it('rejects invalid network recovery options before worker initialization', () => {
    expectOptionError({ network: { readIdleTimeoutMs: 0 } }, 'RIVMUX_INVALID_NETWORK_OPTION')
    expectOptionError({ network: { readIdleTimeoutMs: 1.5 } }, 'RIVMUX_INVALID_NETWORK_OPTION')
    expectOptionError({ network: { retry: { maxAttempts: 0 } } }, 'RIVMUX_INVALID_NETWORK_OPTION')
    expectOptionError({ network: { retry: { maxAttempts: 1.5 } } }, 'RIVMUX_INVALID_NETWORK_OPTION')
    expectOptionError({ network: { retry: { backoffMs: -1 } } }, 'RIVMUX_INVALID_NETWORK_OPTION')
    expectOptionError({ network: { retry: { backoffMs: 500.5 } } }, 'RIVMUX_INVALID_NETWORK_OPTION')
    expectOptionError({ network: { retry: { maxBackoffMs: -1 } } }, 'RIVMUX_INVALID_NETWORK_OPTION')
    expectOptionError({ network: { retry: { backoffMs: 1_000, maxBackoffMs: 500 } } }, 'RIVMUX_INVALID_NETWORK_OPTION')
    expectOptionError({ network: { retry: { jitterRatio: -0.1 } } }, 'RIVMUX_INVALID_NETWORK_OPTION')
    expectOptionError({ network: { retry: { jitterRatio: 1.1 } } }, 'RIVMUX_INVALID_NETWORK_OPTION')
    expectOptionError({ network: { retry: { jitterRatio: Number.NaN } } }, 'RIVMUX_INVALID_NETWORK_OPTION')
  })
})

function expectOptionError(options: RivmuxPlayerOptions, code: string): void {
  try {
    normalizePlayerOptions(options)
    throw new Error(`Expected ${code}.`)
  } catch (error) {
    expect(error).toMatchObject({ name: code })
  }
}
