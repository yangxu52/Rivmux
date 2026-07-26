import { describe, expect, it } from 'vitest'

import { createPlayerStats, getNetworkIdleMs, updateAppendQueueHighWaterMark } from '../../src/runtime/stats'

import type { RuntimeMseStatsSnapshot } from '../../src/runtime/stats'

describe('runtime stats', () => {
  it('uses the latest chunk marker and clamps network idle time to zero', () => {
    expect(getNetworkIdleMs({ bytesReceived: 1, currentNetworkSpeed: 1, startedAtMs: 10, lastChunkAtMs: 20 }, 25)).toBe(5)
    expect(getNetworkIdleMs({ bytesReceived: 1, currentNetworkSpeed: 1, startedAtMs: 30 }, 25)).toBe(0)
  })

  it('projects defaults while preferring latency buffer metrics', () => {
    expect(
      createPlayerStats({
        loaderStats: undefined,
        mseStats: mseStats({ bufferedStart: 1, bufferedEnd: 5, bufferedDuration: 4 }),
        latencyMetrics: { bufferedStart: 2, bufferedEnd: 6, bufferedDuration: 4, liveLatency: 1.5 },
        outputBytes: 128,
        appendQueueMaxLength: 3,
        appendQueueMaxBytes: 4096,
        loaderPaused: true,
        nowMs: 100,
      })
    ).toMatchObject({
      bytesReceived: 0,
      currentNetworkSpeed: 0,
      networkIdleMs: undefined,
      outputBytes: 128,
      appendQueueMaxLength: 3,
      appendQueueMaxBytes: 4096,
      loaderPaused: true,
      bufferedStart: 2,
      bufferedEnd: 6,
      bufferedDuration: 4,
      liveLatency: 1.5,
    })
  })

  it('never decreases append queue high-water marks', () => {
    expect(updateAppendQueueHighWaterMark({ length: 4, bytes: 2048 }, mseStats({ appendQueueLength: 2, appendQueueBytes: 4096 }))).toEqual({
      length: 4,
      bytes: 4096,
    })
  })
})

function mseStats(overrides: Partial<RuntimeMseStatsSnapshot> = {}): RuntimeMseStatsSnapshot {
  return {
    appendQueueLength: 0,
    appendQueueBytes: 0,
    sourceBufferUpdating: false,
    sourceBufferCount: 0,
    bufferedRangeCount: 0,
    bufferedStart: undefined,
    bufferedEnd: undefined,
    bufferedDuration: undefined,
    ...overrides,
  }
}
