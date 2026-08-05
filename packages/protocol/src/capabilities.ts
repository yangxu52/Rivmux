export type SupportStatus = 'supported' | 'unsupported' | 'unknown'

export interface RuntimeCapabilities {
  dedicatedWorker: boolean
  workerMse: boolean
  fetchStreaming: boolean
  readableStream: boolean
  webAssembly: boolean
}

export interface DecodingCapabilities {
  video: {
    avc: SupportStatus
    hevc: SupportStatus
    av1: SupportStatus
  }
  audio: {
    aac: SupportStatus
    opus: SupportStatus
  }
  stableProfiles: {
    avcAac: SupportStatus
    hevcAac: SupportStatus
  }
}

export interface RivmuxCapabilities {
  supported: boolean
  runtime: RuntimeCapabilities
  decoding: DecodingCapabilities
}
