import { describe, expect, it } from 'vitest'

import { normalizePlayerOptions } from '../src/index'

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
      diagnostics: { debug: true },
    })

    expect(options.playback).toStrictEqual({ autoPlay: false, muted: false })
    expect(options.latency.target).toBe(1.5)
    expect(options.latency.startupBuffer).toBe(0.35)
    expect(options.network.headers).toStrictEqual({ Authorization: 'Bearer test' })
    expect(options.network.retry).toStrictEqual({ maxAttempts: 5, backoffMs: 500 })
    expect(options.runtime).toMatchObject({
      preferWorkerMse: true,
    })
    expect(options.diagnostics).toStrictEqual({ statsIntervalMs: 1000, debug: true })
  })

  it('keeps explicit runtime asset overrides', () => {
    const options = normalizePlayerOptions({
      runtime: {
        workerUrl: '/assets/rivmux-runtime-worker.js',
        wasmUrl: '/assets/custom-core.wasm',
      },
    })

    expect(options.runtime).toStrictEqual({
      preferWorkerMse: true,
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

  it('rejects runtime options that are not implemented by the M1 pipeline', () => {
    expectOptionError({ runtime: { preferWorkerMse: false } }, 'RIVMUX_UNSUPPORTED_MAIN_THREAD_MSE_FALLBACK')
    expectOptionError({ runtime: { wasmModule: {} as WebAssembly.Module } }, 'RIVMUX_UNSUPPORTED_WASM_MODULE_OPTION')
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
