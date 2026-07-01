import { createPlayerError, playerErrorToException } from './errors'

import type { NormalizedRivmuxPlayerOptions, PlayerErrorKind, RivmuxPlayerOptions } from '@rivmux/protocol'

export const DEFAULT_RIVMUX_PLAYER_OPTIONS: NormalizedRivmuxPlayerOptions = {
  playback: {
    autoPlay: true,
    muted: false,
  },
  latency: {
    startupBuffer: 0.35,
    target: 1.2,
    max: 2.5,
    maxForwardBuffer: 4,
    backwardBuffer: 1.5,
  },
  network: {
    headers: {},
    credentials: 'same-origin',
    retry: {
      maxAttempts: 3,
      backoffMs: 500,
    },
  },
  runtime: {
    preferWorkerMse: true,
  },
  diagnostics: {
    statsIntervalMs: 1000,
    debug: false,
  },
}

export function normalizePlayerOptions(options: RivmuxPlayerOptions = {}): NormalizedRivmuxPlayerOptions {
  const normalizedOptions = {
    playback: {
      ...DEFAULT_RIVMUX_PLAYER_OPTIONS.playback,
      ...options.playback,
    },
    latency: {
      ...DEFAULT_RIVMUX_PLAYER_OPTIONS.latency,
      ...options.latency,
    },
    network: {
      ...DEFAULT_RIVMUX_PLAYER_OPTIONS.network,
      ...options.network,
      headers: {
        ...DEFAULT_RIVMUX_PLAYER_OPTIONS.network.headers,
        ...options.network?.headers,
      },
      retry: {
        ...DEFAULT_RIVMUX_PLAYER_OPTIONS.network.retry,
        ...options.network?.retry,
      },
    },
    runtime: normalizeRuntimeOptions(options),
    diagnostics: {
      ...DEFAULT_RIVMUX_PLAYER_OPTIONS.diagnostics,
      ...options.diagnostics,
    },
  }

  validateNormalizedOptions(normalizedOptions)
  return normalizedOptions
}

function validateNormalizedOptions(options: NormalizedRivmuxPlayerOptions): void {
  validateLatencyOptions(options)
  validateRuntimeOptions(options)
}

function validateLatencyOptions(options: NormalizedRivmuxPlayerOptions): void {
  const latency = options.latency

  assertFiniteNonNegativeLatency(latency.startupBuffer, 'latency.startupBuffer')
  assertFinitePositiveLatency(latency.target, 'latency.target')
  assertFiniteNonNegativeLatency(latency.max, 'latency.max')
  assertFiniteNonNegativeLatency(latency.maxForwardBuffer, 'latency.maxForwardBuffer')
  assertFiniteNonNegativeLatency(latency.backwardBuffer, 'latency.backwardBuffer')

  if (latency.max < latency.target) {
    throwOptionError('runtime', 'RIVMUX_INVALID_LATENCY_OPTION', 'latency.max must be greater than or equal to latency.target.')
  }

  if (latency.maxForwardBuffer < latency.target) {
    throwOptionError('runtime', 'RIVMUX_INVALID_LATENCY_OPTION', 'latency.maxForwardBuffer must be greater than or equal to latency.target.')
  }
}

function validateRuntimeOptions(options: NormalizedRivmuxPlayerOptions): void {
  if (options.runtime.preferWorkerMse !== true) {
    throwOptionError(
      'unsupported',
      'RIVMUX_UNSUPPORTED_MAIN_THREAD_MSE_FALLBACK',
      'Main-thread MSE fallback is not implemented; runtime.preferWorkerMse must remain true.'
    )
  }
}

function normalizeRuntimeOptions(options: RivmuxPlayerOptions): NormalizedRivmuxPlayerOptions['runtime'] {
  return {
    preferWorkerMse: options.runtime?.preferWorkerMse ?? DEFAULT_RIVMUX_PLAYER_OPTIONS.runtime.preferWorkerMse,
    ...(options.runtime?.workerUrl === undefined ? {} : { workerUrl: options.runtime.workerUrl }),
    ...(options.runtime?.wasmUrl === undefined ? {} : { wasmUrl: options.runtime.wasmUrl }),
  }
}

function assertFiniteNonNegativeLatency(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throwOptionError('runtime', 'RIVMUX_INVALID_LATENCY_OPTION', `${field} must be a finite number greater than or equal to 0.`)
  }
}

function assertFinitePositiveLatency(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throwOptionError('runtime', 'RIVMUX_INVALID_LATENCY_OPTION', `${field} must be a finite number greater than 0.`)
  }
}

function throwOptionError(kind: PlayerErrorKind, code: string, message: string): never {
  throw playerErrorToException(createPlayerError(kind, code, message, true))
}
