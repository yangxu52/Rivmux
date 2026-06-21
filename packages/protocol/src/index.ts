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
  appendQueueLength?: number
  bufferedDuration?: number
  liveLatency?: number
  playbackRate?: number
  droppedFrames?: number
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
