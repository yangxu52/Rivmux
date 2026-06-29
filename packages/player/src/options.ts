import type { NormalizedRivmuxPlayerOptions, RivmuxPlayerOptions } from '@rivmux/protocol'

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
  return {
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
    runtime: {
      ...DEFAULT_RIVMUX_PLAYER_OPTIONS.runtime,
      ...options.runtime,
    },
    diagnostics: {
      ...DEFAULT_RIVMUX_PLAYER_OPTIONS.diagnostics,
      ...options.diagnostics,
    },
  }
}
