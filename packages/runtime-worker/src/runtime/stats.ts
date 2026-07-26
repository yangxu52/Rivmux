import type { StreamLoaderStats } from '../loader/loader'
import type { LatencyMetrics } from '../latency/latency-controller'
import type { PlayerStats } from '@rivmux/protocol'

export type RuntimeMseStatsSnapshot = {
  appendQueueLength: number
  appendQueueBytes: number
  sourceBufferUpdating: boolean
  sourceBufferCount: number
  bufferedRangeCount: number
  bufferedStart: number | undefined
  bufferedEnd: number | undefined
  bufferedDuration: number | undefined
}

export type AppendQueueHighWaterMark = {
  length: number
  bytes: number
}

export type RuntimeStatsSnapshot = {
  loaderStats: StreamLoaderStats | undefined
  mseStats: RuntimeMseStatsSnapshot
  latencyMetrics: LatencyMetrics
  outputBytes: number
  appendQueueMaxLength: number
  appendQueueMaxBytes: number
  loaderPaused: boolean
  nowMs: number
}

export function updateAppendQueueHighWaterMark(current: AppendQueueHighWaterMark, mseStats: RuntimeMseStatsSnapshot): AppendQueueHighWaterMark {
  return {
    length: Math.max(current.length, mseStats.appendQueueLength),
    bytes: Math.max(current.bytes, mseStats.appendQueueBytes),
  }
}

export function getNetworkIdleMs(stats: StreamLoaderStats | undefined, nowMs: number): number | undefined {
  const markerMs = stats?.lastChunkAtMs ?? stats?.startedAtMs
  if (markerMs === undefined) {
    return undefined
  }

  return Math.max(nowMs - markerMs, 0)
}

export function createPlayerStats(snapshot: RuntimeStatsSnapshot): PlayerStats {
  const { loaderStats, mseStats, latencyMetrics } = snapshot
  return {
    bytesReceived: loaderStats?.bytesReceived ?? 0,
    currentNetworkSpeed: loaderStats?.currentNetworkSpeed ?? 0,
    networkIdleMs: getNetworkIdleMs(loaderStats, snapshot.nowMs),
    outputBytes: snapshot.outputBytes,
    appendQueueLength: mseStats.appendQueueLength,
    appendQueueBytes: mseStats.appendQueueBytes,
    appendQueueMaxLength: snapshot.appendQueueMaxLength,
    appendQueueMaxBytes: snapshot.appendQueueMaxBytes,
    loaderPaused: snapshot.loaderPaused,
    sourceBufferUpdating: mseStats.sourceBufferUpdating,
    sourceBufferCount: mseStats.sourceBufferCount,
    bufferedStart: latencyMetrics.bufferedStart ?? mseStats.bufferedStart,
    bufferedEnd: latencyMetrics.bufferedEnd ?? mseStats.bufferedEnd,
    bufferedDuration: latencyMetrics.bufferedDuration ?? mseStats.bufferedDuration,
    bufferedRangeCount: mseStats.bufferedRangeCount,
    currentTime: latencyMetrics.currentTime,
    liveLatency: latencyMetrics.liveLatency,
    playbackRate: latencyMetrics.playbackRate,
    readyState: latencyMetrics.readyState,
    droppedFrames: latencyMetrics.droppedFrames,
  }
}
