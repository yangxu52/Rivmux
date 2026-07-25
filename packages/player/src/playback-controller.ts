import type { NormalizedPlaybackOptions, PlaybackControlAction, PlaybackControlResult, VideoElementState } from '@rivmux/protocol'

export class PlaybackController {
  private readonly options: NormalizedPlaybackOptions
  private video?: HTMLVideoElement
  private stateTimer?: ReturnType<typeof setInterval>

  constructor(options: NormalizedPlaybackOptions) {
    this.options = options
  }

  get attached(): boolean {
    return this.video !== undefined
  }

  isAttachedTo(video: HTMLVideoElement): boolean {
    return this.video === video
  }

  attach(video: HTMLVideoElement): void {
    this.video = video
    video.muted = this.options.muted
    video.autoplay = this.options.autoPlay
  }

  attachMediaSourceHandle(handle: MediaSourceHandle): boolean {
    if (this.video === undefined) {
      return false
    }

    Reflect.set(this.video, 'srcObject', handle)
    return true
  }

  startStateReporting(intervalMs: number, report: (state: VideoElementState) => void): void {
    this.stopStateReporting()
    const reportCurrentState = (): void => {
      const state = this.snapshot()
      if (state !== undefined) {
        report(state)
      }
    }

    reportCurrentState()
    this.stateTimer = setInterval(reportCurrentState, intervalMs)
  }

  stopStateReporting(): void {
    if (this.stateTimer !== undefined) {
      clearInterval(this.stateTimer)
      this.stateTimer = undefined
    }
  }

  async applyControl(action: PlaybackControlAction): Promise<PlaybackControlResult> {
    const video = this.video
    if (video === undefined) {
      return { type: action.type, accepted: false, message: 'No video element is attached.' }
    }

    try {
      switch (action.type) {
        case 'play':
          await video.play()
          break
        case 'set-playback-rate':
          video.playbackRate = action.playbackRate
          break
        case 'seek':
          video.currentTime = action.targetTime
          break
      }
      return { type: action.type, accepted: true }
    } catch (cause) {
      return {
        type: action.type,
        accepted: false,
        message: cause instanceof Error ? cause.message : String(cause),
      }
    }
  }

  detachSource(): void {
    if (this.video === undefined) {
      return
    }

    this.video.pause()
    this.video.playbackRate = 1
    this.video.removeAttribute('src')
    this.video.srcObject = null
    this.video.load()
  }

  release(): void {
    this.stopStateReporting()
    this.detachSource()
    this.video = undefined
  }

  private snapshot(): VideoElementState | undefined {
    const video = this.video
    if (video === undefined) {
      return undefined
    }

    const droppedFrames = getDroppedFrames(video)
    return {
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      readyState: video.readyState,
      playbackRate: video.playbackRate,
      paused: video.paused,
      ...(droppedFrames === undefined ? {} : { droppedFrames }),
    }
  }
}

function getDroppedFrames(video: HTMLVideoElement): number | undefined {
  const quality = video.getVideoPlaybackQuality?.()
  if (quality !== undefined && Number.isFinite(quality.droppedVideoFrames)) {
    return quality.droppedVideoFrames
  }

  const webkitDroppedFrameCount = (video as HTMLVideoElement & { webkitDroppedFrameCount?: number }).webkitDroppedFrameCount
  return Number.isFinite(webkitDroppedFrameCount) ? webkitDroppedFrameCount : undefined
}
