/** Runtime diagnostics emitted by the `stats` event. */
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

/** High-level category for a player error. */
export type PlayerErrorKind = 'network' | 'unsupported' | 'demux' | 'codec' | 'mux' | 'mse' | 'runtime'

/** Structured error emitted by the player and runtime. */
export type PlayerError = {
  kind: PlayerErrorKind
  code: string
  message: string
  terminal: boolean
  cause?: unknown
}

/** Structured recoverable warning emitted by the player and runtime. */
export type PlayerWarning = {
  code: string
  message: string
  cause?: unknown
}
