import { createPlayerError, playerErrorToException } from './errors'

import type { NormalizedRivmuxPlayerOptions, PlayerErrorKind, RivmuxPlayerOptions } from '@rivmux/protocol'

const DEFAULT_RIVMUX_PLAYER_OPTIONS: NormalizedRivmuxPlayerOptions = {
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
    readIdleTimeoutMs: 10_000,
    retry: {
      maxAttempts: 3,
      backoffMs: 500,
      maxBackoffMs: 8_000,
      jitterRatio: 0.2,
    },
  },
  runtime: {},
  diagnostics: { statsIntervalMs: 1000 },
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
  validateNetworkOptions(options)
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

function validateNetworkOptions(options: NormalizedRivmuxPlayerOptions): void {
  const network = options.network
  const retry = network.retry

  assertPositiveInteger(network.readIdleTimeoutMs, 'network.readIdleTimeoutMs')
  assertPositiveInteger(retry.maxAttempts, 'network.retry.maxAttempts')
  assertNonNegativeInteger(retry.backoffMs, 'network.retry.backoffMs')
  assertNonNegativeInteger(retry.maxBackoffMs, 'network.retry.maxBackoffMs')

  if (retry.maxBackoffMs < retry.backoffMs) {
    throwOptionError('runtime', 'RIVMUX_INVALID_NETWORK_OPTION', 'network.retry.maxBackoffMs must be greater than or equal to network.retry.backoffMs.')
  }

  if (!Number.isFinite(retry.jitterRatio) || retry.jitterRatio < 0 || retry.jitterRatio > 1) {
    throwOptionError('runtime', 'RIVMUX_INVALID_NETWORK_OPTION', 'network.retry.jitterRatio must be a finite number between 0 and 1.')
  }
}

function normalizeRuntimeOptions(options: RivmuxPlayerOptions): NormalizedRivmuxPlayerOptions['runtime'] {
  return {
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

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throwOptionError('runtime', 'RIVMUX_INVALID_NETWORK_OPTION', `${field} must be an integer greater than or equal to 1.`)
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throwOptionError('runtime', 'RIVMUX_INVALID_NETWORK_OPTION', `${field} must be an integer greater than or equal to 0.`)
  }
}

function throwOptionError(kind: PlayerErrorKind, code: string, message: string): never {
  throw playerErrorToException(createPlayerError(kind, code, message, true))
}
