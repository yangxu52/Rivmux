/** Container, codec, and track metadata detected from the stream. */
export type MediaInfo = {
  /** Detected media container, such as `flv` or `fmp4`. */
  container: string
  /** Video codec string when the stream contains video. */
  videoCodec?: string
  /** Audio codec string when the stream contains audio. */
  audioCodec?: string
  /** Video width in pixels. */
  width?: number
  /** Video height in pixels. */
  height?: number
  /** Audio sample rate in Hz. */
  audioSampleRate?: number
  /** Number of audio channels. */
  audioChannelCount?: number
}

/** Snapshot of the attached video element sent from the player to the worker. */
export type VideoElementState = {
  currentTime: number
  readyState: number
  playbackRate: number
  paused: boolean
  droppedFrames?: number
}

/** Playback operation requested by the worker-side latency controller. */
export type PlaybackControlAction =
  | { type: 'play'; reason: 'startup-buffer-ready' }
  | { type: 'set-playback-rate'; playbackRate: number; reason: 'latency-above-target' | 'latency-near-target' }
  | { type: 'seek'; targetTime: number; reason: 'latency-max-exceeded' }

/** Structured, clone-safe failure returned for a playback operation. */
export type PlaybackControlError = {
  name: string
  message: string
}

/** Result of applying a worker-requested playback operation. */
export type PlaybackControlResult =
  | {
      type: PlaybackControlAction['type']
      accepted: true
    }
  | {
      type: PlaybackControlAction['type']
      accepted: false
      error: PlaybackControlError
    }
