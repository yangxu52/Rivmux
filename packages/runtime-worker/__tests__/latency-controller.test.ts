import { describe, expect, it } from 'vitest'

import { LatencyController } from '../src/latency/latency-controller'

describe('LatencyController', () => {
  it('requests startup playback after the startup buffer is reached', () => {
    const controller = new LatencyController({
      latency: createLatencyOptions(),
      playback: { autoPlay: true, muted: true },
    })

    expect(controller.evaluate({ ranges: [{ start: 0, end: 0.2 }], loaderPaused: false, nowMs: 0 }).playbackControl).toBeUndefined()
    expect(controller.evaluate({ ranges: [{ start: 0, end: 0.4 }], loaderPaused: false, nowMs: 10 }).playbackControl).toStrictEqual({
      type: 'play',
      reason: 'startup-buffer-ready',
    })
  })

  it('computes live latency and requests cleanup from video state', () => {
    const controller = new LatencyController({
      latency: createLatencyOptions(),
      playback: { autoPlay: false, muted: true },
    })

    const evaluation = controller.evaluate({
      ranges: [{ start: 0, end: 6 }],
      videoState: { currentTime: 3, readyState: 3, playbackRate: 1, paused: false },
      loaderPaused: false,
      nowMs: 0,
    })

    expect(evaluation.metrics).toMatchObject({
      bufferedStart: 0,
      bufferedEnd: 6,
      bufferedDuration: 6,
      currentTime: 3,
      liveLatency: 3,
    })
    expect(evaluation.cleanupBefore).toBe(1.5)
  })

  it('uses hysteresis for loader pause and resume', () => {
    const controller = new LatencyController({
      latency: createLatencyOptions(),
      playback: { autoPlay: false, muted: true },
    })

    expect(
      controller.evaluate({
        ranges: [{ start: 0, end: 6 }],
        videoState: { currentTime: 1, readyState: 3, playbackRate: 1, paused: false },
        loaderPaused: false,
        nowMs: 0,
      }).loaderCommand
    ).toBe('pause')

    expect(
      controller.evaluate({
        ranges: [{ start: 0, end: 6 }],
        videoState: { currentTime: 5, readyState: 3, playbackRate: 1, paused: false },
        loaderPaused: true,
        nowMs: 100,
      }).loaderCommand
    ).toBe('resume')
  })
})

function createLatencyOptions() {
  return {
    startupBuffer: 0.35,
    target: 1.2,
    max: 2.5,
    maxForwardBuffer: 4,
    backwardBuffer: 1.5,
  }
}
