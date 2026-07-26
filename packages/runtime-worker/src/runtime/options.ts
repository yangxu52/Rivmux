import type { NormalizedRivmuxPlayerOptions } from '@rivmux/protocol'

export function mergeOptions(current: NormalizedRivmuxPlayerOptions, updates: Partial<NormalizedRivmuxPlayerOptions>): NormalizedRivmuxPlayerOptions {
  return {
    playback: {
      ...current.playback,
      ...updates.playback,
    },
    latency: {
      ...current.latency,
      ...updates.latency,
    },
    network: {
      ...current.network,
      ...updates.network,
      headers: {
        ...current.network.headers,
        ...updates.network?.headers,
      },
      retry: {
        ...current.network.retry,
        ...updates.network?.retry,
      },
    },
    runtime: {
      ...current.runtime,
      ...updates.runtime,
    },
    diagnostics: {
      ...current.diagnostics,
      ...updates.diagnostics,
    },
  }
}
