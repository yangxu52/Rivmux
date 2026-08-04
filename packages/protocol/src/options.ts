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
  /** Maximum time without a stream chunk while reads are active, in milliseconds. */
  readIdleTimeoutMs?: number
  /** Retry policy for recoverable stream request failures. */
  retry?: {
    /** Maximum connection attempts per recovery cycle, including the current connection. */
    maxAttempts?: number
    /** Base exponential retry delay in milliseconds. */
    backoffMs?: number
    /** Maximum retry delay after jitter is applied, in milliseconds. */
    maxBackoffMs?: number
    /** Symmetric jitter ratio in the inclusive range from 0 to 1. */
    jitterRatio?: number
  }
}

/** Advanced runtime asset deployment options. */
export type RuntimeOptions = {
  /** Must remain true while M1 supports only worker-backed Media Source Extensions. */
  preferWorkerMse?: boolean
  /** Overrides the packaged Dedicated Worker script URL. */
  workerUrl?: string
  /** Overrides the WASM binary URL used by the packaged wasm-bindgen runtime. */
  wasmUrl?: string
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
  readIdleTimeoutMs: number
  retry: {
    maxAttempts: number
    backoffMs: number
    maxBackoffMs: number
    jitterRatio: number
  }
}

export type NormalizedRuntimeOptions = {
  preferWorkerMse: boolean
  workerUrl?: string
  wasmUrl?: string
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
