import { createPlayerError } from './errors'

import type { PlayerError, RivmuxCapabilities, RuntimeCapabilities, SupportStatus } from '@rivmux/protocol'

interface CapabilityEnvironment {
  dedicatedWorker: boolean
  fetchStreaming: boolean
  readableStream: boolean
  webAssembly: boolean
  mediaSource: boolean
  workerMseConstructable: boolean
  isTypeSupported?: (mime: string) => boolean
}

const MIME = {
  avc: 'video/mp4; codecs="avc1.42E01E"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
  av1: 'video/mp4; codecs="av01.0.08M.08"',
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  opus: 'audio/mp4; codecs="opus"',
} as const

function safelyRead<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

function readCapabilityEnvironment(): CapabilityEnvironment {
  const dedicatedWorker = safelyRead(() => typeof Worker === 'function', false)
  const fetchAvailable = safelyRead(() => typeof fetch === 'function', false)
  const responseBodyAvailable = safelyRead(() => typeof Response === 'function' && Response.prototype !== undefined && 'body' in Response.prototype, false)
  const readableStream = safelyRead(() => typeof ReadableStream === 'function', false)
  const webAssembly = safelyRead(() => typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function', false)
  const mediaSourceConstructor = safelyRead(() => (typeof MediaSource === 'function' ? MediaSource : undefined), undefined as typeof MediaSource | undefined)
  const mediaSource = mediaSourceConstructor !== undefined
  const workerMseConstructable = mediaSource && safelyRead(() => mediaSourceConstructor.canConstructInDedicatedWorker === true, false)
  const isTypeSupported = mediaSource
    ? safelyRead(
        () => (typeof mediaSourceConstructor.isTypeSupported === 'function' ? mediaSourceConstructor.isTypeSupported.bind(mediaSourceConstructor) : undefined),
        undefined
      )
    : undefined

  return {
    dedicatedWorker,
    fetchStreaming: fetchAvailable && responseBodyAvailable,
    readableStream,
    webAssembly,
    mediaSource,
    workerMseConstructable,
    isTypeSupported,
  }
}

function probeMime(isTypeSupported: CapabilityEnvironment['isTypeSupported'], mime: string): SupportStatus {
  if (isTypeSupported === undefined) {
    return 'unknown'
  }

  try {
    return isTypeSupported(mime) ? 'supported' : 'unsupported'
  } catch {
    return 'unknown'
  }
}

function combineProfile(video: SupportStatus, audio: SupportStatus): SupportStatus {
  if (video === 'unsupported' || audio === 'unsupported') {
    return 'unsupported'
  }
  if (video === 'supported' && audio === 'supported') {
    return 'supported'
  }
  return 'unknown'
}

function getCapabilitiesForEnvironment(environment: CapabilityEnvironment): RivmuxCapabilities {
  const runtime: RuntimeCapabilities = {
    dedicatedWorker: environment.dedicatedWorker,
    workerMse: environment.workerMseConstructable && environment.isTypeSupported !== undefined,
    fetchStreaming: environment.fetchStreaming,
    readableStream: environment.readableStream,
    webAssembly: environment.webAssembly,
  }
  const video = {
    avc: probeMime(environment.isTypeSupported, MIME.avc),
    hevc: probeMime(environment.isTypeSupported, MIME.hevc),
    av1: probeMime(environment.isTypeSupported, MIME.av1),
  }
  const audio = {
    aac: probeMime(environment.isTypeSupported, MIME.aac),
    opus: probeMime(environment.isTypeSupported, MIME.opus),
  }

  return {
    supported: Object.values(runtime).every(Boolean),
    runtime,
    decoding: {
      video,
      audio,
      stableProfiles: {
        avcAac: combineProfile(video.avc, audio.aac),
        hevcAac: combineProfile(video.hevc, audio.aac),
      },
    },
  }
}

export function getCapabilities(): RivmuxCapabilities {
  return getCapabilitiesForEnvironment(readCapabilityEnvironment())
}

export function isSupported(): boolean {
  return getCapabilities().supported
}

export function detectMainThreadRuntime(environment = readCapabilityEnvironment()): PlayerError | undefined {
  if (!environment.dedicatedWorker) {
    return createPlayerError('unsupported', 'RIVMUX_UNSUPPORTED_WORKER', 'Dedicated Worker is not available in this runtime.', true)
  }

  if (!environment.fetchStreaming) {
    return createPlayerError('unsupported', 'RIVMUX_UNSUPPORTED_FETCH', 'Fetch is not available in this runtime.', true)
  }

  if (!environment.readableStream) {
    return createPlayerError('unsupported', 'RIVMUX_UNSUPPORTED_READABLE_STREAM', 'ReadableStream is not available in this runtime.', true)
  }

  if (!environment.webAssembly) {
    return createPlayerError('unsupported', 'RIVMUX_UNSUPPORTED_WASM', 'WebAssembly is not available in this runtime.', true)
  }

  if (!environment.mediaSource) {
    return createPlayerError('unsupported', 'RIVMUX_UNSUPPORTED_MSE', 'MediaSource is not available in this runtime.', true)
  }

  if (!environment.workerMseConstructable) {
    return createPlayerError('unsupported', 'RIVMUX_UNSUPPORTED_WORKER_MSE', 'MediaSource cannot be constructed in a dedicated worker in this runtime.', true)
  }

  if (environment.isTypeSupported === undefined) {
    return createPlayerError('unsupported', 'RIVMUX_UNSUPPORTED_MSE_TYPE_CHECK', 'MediaSource.isTypeSupported is not available in this runtime.', true)
  }

  return undefined
}
