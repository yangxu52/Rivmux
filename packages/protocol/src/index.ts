export type PlaybackOptions = {
  autoPlay?: boolean
  muted?: boolean
}

export type LatencyOptions = {
  startupBuffer?: number
  target?: number
  max?: number
  maxForwardBuffer?: number
  backwardBuffer?: number
}

export type NetworkOptions = {
  headers?: Record<string, string>
  credentials?: RequestCredentials
  retry?: {
    maxAttempts?: number
    backoffMs?: number
  }
}

export type RuntimeOptions = {
  preferWorkerMse?: boolean
  workerUrl?: string
  wasmUrl?: string
  wasmModule?: WebAssembly.Module
}

export type DiagnosticsOptions = {
  statsIntervalMs?: number
  debug?: boolean
}

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

export type NormalizedRivmuxPlayerOptions = {
  playback: NormalizedPlaybackOptions
  latency: NormalizedLatencyOptions
  network: NormalizedNetworkOptions
  runtime: NormalizedRuntimeOptions
  diagnostics: NormalizedDiagnosticsOptions
}

export type MediaInfo = {
  container: string
  videoCodec?: string
  audioCodec?: string
  width?: number
  height?: number
  audioSampleRate?: number
  audioChannelCount?: number
}

export type PlayerStats = {
  bytesReceived?: number
  currentNetworkSpeed?: number
  networkIdleMs?: number
  outputBytes?: number
  appendQueueLength?: number
  appendQueueBytes?: number
  appendQueueMaxLength?: number
  appendQueueMaxBytes?: number
  loaderPaused?: boolean
  sourceBufferUpdating?: boolean
  sourceBufferCount?: number
  bufferedStart?: number
  bufferedEnd?: number
  bufferedDuration?: number
  bufferedRangeCount?: number
  currentTime?: number
  liveLatency?: number
  playbackRate?: number
  readyState?: number
  droppedFrames?: number
}

export type VideoElementState = {
  currentTime: number
  readyState: number
  playbackRate: number
  paused: boolean
  droppedFrames?: number
}

export type PlaybackControlAction =
  | { type: 'play'; reason: 'startup-buffer-ready' }
  | { type: 'set-playback-rate'; playbackRate: number; reason: 'latency-above-target' | 'latency-near-target' }
  | { type: 'seek'; targetTime: number; reason: 'latency-max-exceeded' }

export type PlaybackControlResult = {
  type: PlaybackControlAction['type']
  accepted: boolean
  message?: string
}

export type PlayerErrorKind = 'network' | 'unsupported' | 'demux' | 'codec' | 'mux' | 'mse' | 'runtime'

export type PlayerError = {
  kind: PlayerErrorKind
  code: string
  message: string
  terminal: boolean
  cause?: unknown
}

export type PlayerWarning = {
  code: string
  message: string
  cause?: unknown
}

export type PlayerEventMap = {
  ready: undefined
  mediaInfo: MediaInfo
  stats: PlayerStats
  warning: PlayerWarning
  error: PlayerError
  stopped: undefined
  destroyed: undefined
}

export type PlayerEventType = keyof PlayerEventMap

export type PlayerEventListener<T extends PlayerEventType> = (payload: PlayerEventMap[T]) => void

export type WorkerCommand =
  | { type: 'init'; id: string; url: string; options: NormalizedRivmuxPlayerOptions }
  | { type: 'attach-media-source' }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'update-options'; options: Partial<NormalizedRivmuxPlayerOptions> }
  | { type: 'video-state'; state: VideoElementState }
  | { type: 'playback-control-result'; result: PlaybackControlResult }
  | { type: 'destroy' }

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
