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

  it('never requests startup playback when autoPlay is disabled', () => {
    const controller = new LatencyController({
      latency: createLatencyOptions(),
      playback: { autoPlay: false, muted: true },
    })
    const input = { ranges: [{ start: 0, end: 1 }], loaderPaused: false, nowMs: 0 }

    expect(controller.evaluate(input).playbackControl).toBeUndefined()
    expect(controller.evaluate({ ...input, nowMs: 100 }).playbackControl).toBeUndefined()
  })

  it('does not retry a rejected startup play until a new session resets the controller', () => {
    const controller = new LatencyController({
      latency: createLatencyOptions(),
      playback: { autoPlay: true, muted: false },
    })
    const input = { ranges: [{ start: 0, end: 1 }], loaderPaused: false, nowMs: 0 }

    expect(controller.evaluate(input).playbackControl).toStrictEqual({ type: 'play', reason: 'startup-buffer-ready' })
    controller.recordPlaybackControlResult({
      type: 'play',
      accepted: false,
      error: { name: 'NotAllowedError', message: 'Playback requires a user gesture.' },
    })
    expect(controller.evaluate({ ...input, nowMs: 100 }).playbackControl).toBeUndefined()

    controller.reset()
    expect(controller.evaluate({ ...input, nowMs: 200 }).playbackControl).toStrictEqual({ type: 'play', reason: 'startup-buffer-ready' })
    expect(controller.evaluate({ ...input, nowMs: 300 }).playbackControl).toBeUndefined()
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
