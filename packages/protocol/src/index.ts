/** Playback behavior applied to the attached video element. */
export type PlaybackOptions = {
  /** Request playback automatically after the startup buffer is ready. */
  autoPlay?: boolean

  /** Sets `HTMLVideoElement.muted` before playback starts. */
  muted?: boolean
}

/** Low-latency live playback policy, expressed in seconds. */
export type LatencyOptions = {
  /** Minimum buffered duration required before automatic playback starts. */
  startupBuffer?: number

  /** Desired live latency behind the live edge. */
  target?: number

  /** Maximum live latency before the runtime seeks closer to the live edge. */
  max?: number

  /** Forward buffer threshold where the stream loader may pause. */
  maxForwardBuffer?: number

  /** Buffered duration to keep behind the current playhead during cleanup. */
  backwardBuffer?: number
}

/** HTTP request settings for stream loading. */
export type NetworkOptions = {
  /** Additional request headers sent with stream fetch requests. */
  headers?: Record<string, string>

  /** Fetch credentials mode used for stream requests. */
  credentials?: RequestCredentials

  /** Retry policy for recoverable stream request failures. */
  retry?: {
    /** Maximum number of attempts for a stream request. */
    maxAttempts?: number

    /** Base retry delay in milliseconds. */
    backoffMs?: number
  }
}

/** Runtime asset and worker selection options. */
export type RuntimeOptions = {
  /** Prefer worker-backed Media Source Extensions when supported. */
  preferWorkerMse?: boolean

  /** Overrides the worker script URL used by the default runtime. */
  workerUrl?: string

  /**
   * Overrides the WASM asset URL. The matching wasm-bindgen JS glue file must
   * be available at the same path with `.js` instead of `.wasm`.
   */
  wasmUrl?: string

  /** Precompiled WASM module for custom runtime integrations. */
  wasmModule?: WebAssembly.Module
}

/** Diagnostics and debug reporting options. */
export type DiagnosticsOptions = {
  /** Requested runtime stats interval in milliseconds. */
  statsIntervalMs?: number

  /** Enables debug-oriented behavior where supported by the runtime. */
  debug?: boolean
}

/** Top-level options accepted by `new RivmuxPlayer(url, options)`. */
export type RivmuxPlayerOptions = {
  playback?: PlaybackOptions
  latency?: LatencyOptions
  network?: NetworkOptions
  runtime?: RuntimeOptions
  diagnostics?: DiagnosticsOptions
}

export type NormalizedPlaybackOptions = Required<PlaybackOptions>

export type NormalizedLatencyOptions = Required<LatencyOptions>

export type NormalizedNetworkOptions = {
  headers: Record<string, string>
  credentials: RequestCredentials
  retry: {
    maxAttempts: number
    backoffMs: number
  }
}

export type NormalizedRuntimeOptions = {
  preferWorkerMse: boolean
  workerUrl?: string
  wasmUrl?: string
  wasmModule?: WebAssembly.Module
}

export type NormalizedDiagnosticsOptions = Required<DiagnosticsOptions>

/** Fully populated player options after defaults are applied. */
export type NormalizedRivmuxPlayerOptions = {
  playback: NormalizedPlaybackOptions
  latency: NormalizedLatencyOptions
  network: NormalizedNetworkOptions
  runtime: NormalizedRuntimeOptions
  diagnostics: NormalizedDiagnosticsOptions
}

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

/** Runtime diagnostics emitted by the `stats` event. */
export type PlayerStats = {
  /** Number of source bytes received from the stream loader. */
  bytesReceived?: number

  /** Current estimated network speed in bytes per second. */
  currentNetworkSpeed?: number

  /** Duration since the last network chunk, in milliseconds. */
  networkIdleMs?: number

  /** Number of transmuxed bytes emitted to MSE. */
  outputBytes?: number

  /** Number of media segments waiting to be appended. */
  appendQueueLength?: number

  /** Total bytes waiting in the append queue. */
  appendQueueBytes?: number

  /** Maximum append queue length observed in the current session. */
  appendQueueMaxLength?: number

  /** Maximum append queue bytes observed in the current session. */
  appendQueueMaxBytes?: number

  /** Whether the loader is paused by latency/buffer policy. */
  loaderPaused?: boolean

  /** Whether any SourceBuffer is currently updating. */
  sourceBufferUpdating?: boolean

  /** Number of active SourceBuffer instances. */
  sourceBufferCount?: number

  /** Start time of the buffered range used for latency calculations. */
  bufferedStart?: number

  /** End time of the buffered range used for latency calculations. */
  bufferedEnd?: number

  /** Buffered duration ahead of the current playhead. */
  bufferedDuration?: number

  /** Number of buffered ranges on the attached video element. */
  bufferedRangeCount?: number

  /** Current video playhead time. */
  currentTime?: number

  /** Estimated live latency in seconds. */
  liveLatency?: number

  /** Current video playback rate. */
  playbackRate?: number

  /** Current `HTMLMediaElement.readyState`. */
  readyState?: number

  /** Dropped video frame count when the browser exposes it. */
  droppedFrames?: number
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

/** Result of applying a worker-requested playback operation. */
export type PlaybackControlResult = {
  type: PlaybackControlAction['type']
  accepted: boolean
  message?: string
}

/** High-level category for a player error. */
export type PlayerErrorKind = 'network' | 'unsupported' | 'demux' | 'codec' | 'mux' | 'mse' | 'runtime'

/** Structured error emitted by the player and runtime. */
export type PlayerError = {
  /** Broad error category. */
  kind: PlayerErrorKind

  /** Stable machine-readable error code. */
  code: string

  /** Human-readable error message. */
  message: string

  /** Whether playback should be treated as unrecoverable. */
  terminal: boolean

  /** Optional underlying error or diagnostic payload. */
  cause?: unknown
}

/** Structured recoverable warning emitted by the player and runtime. */
export type PlayerWarning = {
  /** Stable machine-readable warning code. */
  code: string

  /** Human-readable warning message. */
  message: string

  /** Optional underlying warning payload. */
  cause?: unknown
}

/** Payload map for player events. */
export type PlayerEventMap = {
  /** Worker/runtime initialization completed. */
  ready: undefined

  /** Stream metadata was detected. */
  mediaInfo: MediaInfo

  /** Runtime diagnostics were sampled. */
  stats: PlayerStats

  /** A recoverable runtime warning occurred. */
  warning: PlayerWarning

  /** A structured runtime error occurred. */
  error: PlayerError

  /** The stream stopped and the media source was detached. */
  stopped: undefined

  /** The worker/runtime was destroyed. */
  destroyed: undefined
}

/** Player event name. */
export type PlayerEventType = keyof PlayerEventMap

/** Typed player event listener. */
export type PlayerEventListener<T extends PlayerEventType> = (payload: PlayerEventMap[T]) => void

/** Command sent from the player facade to the runtime worker. */
export type WorkerCommand =
  | { type: 'init'; id: string; url: string; options: NormalizedRivmuxPlayerOptions }
  | { type: 'attach-media-source' }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'update-options'; options: Partial<NormalizedRivmuxPlayerOptions> }
  | { type: 'video-state'; state: VideoElementState }
  | { type: 'playback-control-result'; result: PlaybackControlResult }
  | { type: 'destroy' }

/** Message sent from the runtime worker to the player facade. */
export type WorkerMessage =
  | { type: 'worker-ready' }
  | { type: 'ready' }
  | { type: 'media-source-handle'; handle: MediaSourceHandle }
  | { type: 'media-info'; mediaInfo: MediaInfo }
  | { type: 'stats'; stats: PlayerStats }
  | { type: 'warning'; warning: PlayerWarning }
  | { type: 'error'; error: PlayerError }
  | { type: 'playback-control'; action: PlaybackControlAction }
  | { type: 'stopped' }
  | { type: 'destroyed' }
