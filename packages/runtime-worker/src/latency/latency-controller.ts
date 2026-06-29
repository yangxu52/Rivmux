import { getBufferedDuration, getBufferedStart, getForwardBuffer, getLiveEdge } from './buffer-ranges'

import type { NormalizedPlaybackOptions, NormalizedLatencyOptions, PlaybackControlAction, PlaybackControlResult, VideoElementState } from '@rivmux/protocol'
import type { BufferedRange } from './buffer-ranges'

export type LatencyMetrics = {
  bufferedStart?: number
  bufferedEnd?: number
  bufferedDuration?: number
  currentTime?: number
  forwardBuffer?: number
  liveLatency?: number
  playbackRate?: number
  readyState?: number
  droppedFrames?: number
}

export type LatencyEvaluationInput = {
  ranges: readonly BufferedRange[]
  videoState?: VideoElementState
  loaderPaused: boolean
  nowMs: number
}

export type LatencyEvaluation = {
  metrics: LatencyMetrics
  cleanupBefore?: number
  loaderCommand?: 'pause' | 'resume'
  playbackControl?: PlaybackControlAction
}

export class LatencyController {
  private readonly latency: NormalizedLatencyOptions
  private readonly playback: NormalizedPlaybackOptions
  private startupPlayRequested = false
  private pendingPlaybackControl?: PlaybackControlAction['type']
  private lastSeekRequestAtMs = Number.NEGATIVE_INFINITY

  constructor(config: { latency: NormalizedLatencyOptions; playback: NormalizedPlaybackOptions }) {
    this.latency = config.latency
    this.playback = config.playback
  }

  evaluate(input: LatencyEvaluationInput): LatencyEvaluation {
    const metrics = this.computeMetrics(input)
    const evaluation: LatencyEvaluation = { metrics }

    if (metrics.currentTime !== undefined) {
      const cleanupBefore = metrics.currentTime - this.latency.backwardBuffer
      if (cleanupBefore > 0) {
        evaluation.cleanupBefore = cleanupBefore
      }
    }

    const forwardBuffer = metrics.forwardBuffer ?? metrics.bufferedDuration
    if (forwardBuffer !== undefined) {
      if (!input.loaderPaused && forwardBuffer >= this.latency.maxForwardBuffer) {
        evaluation.loaderCommand = 'pause'
      } else if (input.loaderPaused && forwardBuffer <= this.latency.target) {
        evaluation.loaderCommand = 'resume'
      }
    }

    evaluation.playbackControl = this.evaluatePlaybackControl(input, metrics)
    return evaluation
  }

  recordPlaybackControlResult(result: PlaybackControlResult): void {
    if (this.pendingPlaybackControl === result.type) {
      this.pendingPlaybackControl = undefined
    }
  }

  reset(): void {
    this.startupPlayRequested = false
    this.pendingPlaybackControl = undefined
    this.lastSeekRequestAtMs = Number.NEGATIVE_INFINITY
  }

  private computeMetrics(input: LatencyEvaluationInput): LatencyMetrics {
    const bufferedStart = getBufferedStart(input.ranges)
    const bufferedEnd = getLiveEdge(input.ranges)
    const bufferedDuration = getBufferedDuration(input.ranges)
    const videoState = input.videoState
    const metrics: LatencyMetrics = {
      bufferedStart,
      bufferedEnd,
      bufferedDuration,
    }

    if (videoState === undefined) {
      return metrics
    }

    const forwardBuffer = getForwardBuffer(input.ranges, videoState.currentTime)
    metrics.currentTime = videoState.currentTime
    metrics.forwardBuffer = forwardBuffer
    metrics.playbackRate = videoState.playbackRate
    metrics.readyState = videoState.readyState
    metrics.droppedFrames = videoState.droppedFrames
    metrics.liveLatency = forwardBuffer
    return metrics
  }

  private evaluatePlaybackControl(input: LatencyEvaluationInput, metrics: LatencyMetrics): PlaybackControlAction | undefined {
    if (this.pendingPlaybackControl !== undefined) {
      return undefined
    }

    if (
      !this.startupPlayRequested &&
      this.playback.autoPlay &&
      metrics.bufferedDuration !== undefined &&
      metrics.bufferedDuration >= this.latency.startupBuffer
    ) {
      this.startupPlayRequested = true
      this.pendingPlaybackControl = 'play'
      return { type: 'play', reason: 'startup-buffer-ready' }
    }

    if (input.videoState === undefined || metrics.liveLatency === undefined || metrics.bufferedEnd === undefined) {
      return undefined
    }

    if (metrics.liveLatency > this.latency.max) {
      const seekTarget = Math.max(metrics.bufferedStart ?? 0, metrics.bufferedEnd - this.latency.target)
      const hasSeekCooldownElapsed = input.nowMs - this.lastSeekRequestAtMs >= SEEK_COOLDOWN_MS
      if (hasSeekCooldownElapsed && Math.abs(seekTarget - input.videoState.currentTime) >= SEEK_MIN_DELTA_SECONDS) {
        this.lastSeekRequestAtMs = input.nowMs
        this.pendingPlaybackControl = 'seek'
        return { type: 'seek', targetTime: seekTarget, reason: 'latency-max-exceeded' }
      }
      return undefined
    }

    if (metrics.liveLatency > this.latency.target + PLAYBACK_RATE_CHASE_THRESHOLD_SECONDS) {
      if (Math.abs(input.videoState.playbackRate - PLAYBACK_RATE_CHASE) >= PLAYBACK_RATE_EPSILON) {
        this.pendingPlaybackControl = 'set-playback-rate'
        return { type: 'set-playback-rate', playbackRate: PLAYBACK_RATE_CHASE, reason: 'latency-above-target' }
      }
    } else if (input.videoState.playbackRate !== 1 && metrics.liveLatency <= this.latency.target + PLAYBACK_RATE_RESTORE_THRESHOLD_SECONDS) {
      this.pendingPlaybackControl = 'set-playback-rate'
      return { type: 'set-playback-rate', playbackRate: 1, reason: 'latency-near-target' }
    }

    return undefined
  }
}

const PLAYBACK_RATE_CHASE = 1.05
const PLAYBACK_RATE_EPSILON = 0.005
const PLAYBACK_RATE_CHASE_THRESHOLD_SECONDS = 0.25
const PLAYBACK_RATE_RESTORE_THRESHOLD_SECONDS = 0.1
const SEEK_COOLDOWN_MS = 1000
const SEEK_MIN_DELTA_SECONDS = 0.1
