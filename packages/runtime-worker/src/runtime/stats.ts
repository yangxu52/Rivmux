import type { StreamLoaderStats } from '../loader/loader'

export function getNetworkIdleMs(stats: StreamLoaderStats | undefined, nowMs: number): number | undefined {
  const markerMs = stats?.lastChunkAtMs ?? stats?.startedAtMs
  if (markerMs === undefined) {
    return undefined
  }

  return Math.max(nowMs - markerMs, 0)
}
