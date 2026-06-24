import type { MediaInfo, PlayerError, PlayerWarning } from 'rivmux-protocol'

export type CoreErrorCode =
  | 'unsupportedContainer'
  | 'unsupportedVideoCodec'
  | 'unsupportedAudioCodec'
  | 'invalidContainerData'
  | 'invalidCodecConfig'
  | 'invalidTimestamp'
  | 'muxerError'
  | 'internalError'

export type CoreError = {
  code: CoreErrorCode
  message: string
}

export type CoreProbeResult = {
  container: 'flv' | 'mpegTs'
  video?: 'avc' | 'hevc' | 'av1'
  audio?: 'aac' | 'mp3' | 'ac3' | 'eac3' | 'opus'
}

export type CoreMediaInfo = {
  container: CoreProbeResult['container']
  video?: CoreProbeResult['video']
  audio?: CoreProbeResult['audio']
  videoCodec?: string
  audioCodec?: string
  width?: number
  height?: number
  audioSampleRate?: number
  audioChannelCount?: number
}

export type CoreWarning = {
  code: string
  message: string
}

export type CoreEvent =
  | { type: 'probeResult'; data: CoreProbeResult }
  | { type: 'mediaInfo'; data: CoreMediaInfo }
  | { type: 'videoConfig'; data: unknown }
  | { type: 'audioConfig'; data: unknown }
  | { type: 'videoSample'; data: unknown }
  | { type: 'audioSample'; data: unknown }
  | { type: 'metadata'; data: unknown }
  | { type: 'warning'; data: CoreWarning }
  | { type: 'fatalError'; data: CoreError }
  | { type: 'discontinuity'; data: unknown }

export type TransmuxCoreHost = {
  pushChunk(chunk: Uint8Array): CoreEvent[]
  flush(): CoreEvent[]
  reset(): void
  destroy(): void
}

export type TransmuxCoreWasmConstructor = new () => {
  pushChunk(chunk: Uint8Array): unknown
  flush(): unknown
  reset(): void
  destroy(): void
}

export class WasmTransmuxCoreHost implements TransmuxCoreHost {
  private readonly core: InstanceType<TransmuxCoreWasmConstructor>

  constructor(Core: TransmuxCoreWasmConstructor) {
    this.core = new Core()
  }

  pushChunk(chunk: Uint8Array): CoreEvent[] {
    return normalizeCoreEvents(this.core.pushChunk(chunk))
  }

  flush(): CoreEvent[] {
    return normalizeCoreEvents(this.core.flush())
  }

  reset(): void {
    this.core.reset()
  }

  destroy(): void {
    this.core.destroy()
  }
}

export function normalizeCoreEvents(value: unknown): CoreEvent[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Transmux core returned a non-array event payload.')
  }

  return value.map((event) => normalizeCoreEvent(event))
}

export function coreMediaInfoToPlayerMediaInfo(mediaInfo: CoreMediaInfo): MediaInfo {
  const result: MediaInfo = {
    container: mediaInfo.container,
  }
  if (mediaInfo.videoCodec !== undefined) {
    result.videoCodec = mediaInfo.videoCodec
  }
  if (mediaInfo.audioCodec !== undefined) {
    result.audioCodec = mediaInfo.audioCodec
  }
  if (mediaInfo.width !== undefined) {
    result.width = mediaInfo.width
  }
  if (mediaInfo.height !== undefined) {
    result.height = mediaInfo.height
  }
  if (mediaInfo.audioSampleRate !== undefined) {
    result.audioSampleRate = mediaInfo.audioSampleRate
  }
  if (mediaInfo.audioChannelCount !== undefined) {
    result.audioChannelCount = mediaInfo.audioChannelCount
  }
  return result
}

export function coreErrorToPlayerError(error: CoreError): PlayerError {
  return {
    kind: coreErrorKind(error.code),
    code: `RIVMUX_CORE_${coreErrorCodeLabel(error.code)}`,
    message: error.message,
    terminal: true,
  }
}

export function coreWarningToPlayerWarning(warning: CoreWarning): PlayerWarning {
  return {
    code: warning.code,
    message: warning.message,
  }
}

function normalizeCoreEvent(value: unknown): CoreEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new TypeError('Transmux core event is missing a string type.')
  }

  const data = value.data
  switch (value.type) {
    case 'probeResult':
      return { type: 'probeResult', data: normalizeProbeResult(data) }
    case 'mediaInfo':
      return { type: 'mediaInfo', data: normalizeMediaInfo(data) }
    case 'videoConfig':
    case 'audioConfig':
    case 'videoSample':
    case 'audioSample':
    case 'metadata':
    case 'discontinuity':
      return { type: value.type, data }
    case 'warning':
      return { type: 'warning', data: normalizeWarning(data) }
    case 'fatalError':
      return { type: 'fatalError', data: normalizeError(data) }
    default:
      throw new TypeError(`Unsupported transmux core event type: ${value.type}.`)
  }
}

function normalizeProbeResult(value: unknown): CoreProbeResult {
  if (!isRecord(value) || (value.container !== 'flv' && value.container !== 'mpegTs')) {
    throw new TypeError('Transmux core probe result has an unsupported container.')
  }

  const result: CoreProbeResult = {
    container: value.container,
  }
  const video = normalizeOptionalString(value.video, ['avc', 'hevc', 'av1'])
  const audio = normalizeOptionalString(value.audio, ['aac', 'mp3', 'ac3', 'eac3', 'opus'])
  if (video !== undefined) {
    result.video = video
  }
  if (audio !== undefined) {
    result.audio = audio
  }
  return result
}

function normalizeMediaInfo(value: unknown): CoreMediaInfo {
  if (!isRecord(value)) {
    throw new TypeError('Transmux core mediaInfo event payload must be an object.')
  }

  const result: CoreMediaInfo = {
    ...normalizeProbeResult(value),
  }
  const videoCodec = normalizeOptionalPrimitive(value.videoCodec, 'string')
  const audioCodec = normalizeOptionalPrimitive(value.audioCodec, 'string')
  const width = normalizeOptionalPrimitive(value.width, 'number')
  const height = normalizeOptionalPrimitive(value.height, 'number')
  const audioSampleRate = normalizeOptionalPrimitive(value.audioSampleRate, 'number')
  const audioChannelCount = normalizeOptionalPrimitive(value.audioChannelCount, 'number')
  if (videoCodec !== undefined) {
    result.videoCodec = videoCodec
  }
  if (audioCodec !== undefined) {
    result.audioCodec = audioCodec
  }
  if (width !== undefined) {
    result.width = width
  }
  if (height !== undefined) {
    result.height = height
  }
  if (audioSampleRate !== undefined) {
    result.audioSampleRate = audioSampleRate
  }
  if (audioChannelCount !== undefined) {
    result.audioChannelCount = audioChannelCount
  }
  return result
}

function normalizeWarning(value: unknown): CoreWarning {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') {
    throw new TypeError('Transmux core warning payload must include code and message.')
  }

  return {
    code: value.code,
    message: value.message,
  }
}

function normalizeError(value: unknown): CoreError {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') {
    throw new TypeError('Transmux core error payload must include code and message.')
  }

  return {
    code: normalizeCoreErrorCode(value.code),
    message: value.message,
  }
}

function normalizeCoreErrorCode(code: string): CoreErrorCode {
  const codes = [
    'unsupportedContainer',
    'unsupportedVideoCodec',
    'unsupportedAudioCodec',
    'invalidContainerData',
    'invalidCodecConfig',
    'invalidTimestamp',
    'muxerError',
    'internalError',
  ] as const

  if (!codes.includes(code as CoreErrorCode)) {
    throw new TypeError(`Unsupported transmux core error code: ${code}.`)
  }

  return code as CoreErrorCode
}

function coreErrorKind(code: CoreErrorCode): PlayerError['kind'] {
  switch (code) {
    case 'unsupportedContainer':
    case 'unsupportedVideoCodec':
    case 'unsupportedAudioCodec':
      return 'unsupported'
    case 'invalidContainerData':
      return 'demux'
    case 'invalidCodecConfig':
      return 'codec'
    case 'invalidTimestamp':
      return 'demux'
    case 'muxerError':
      return 'mux'
    case 'internalError':
      return 'runtime'
  }
}

function coreErrorCodeLabel(code: CoreErrorCode): string {
  return code.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()
}

function normalizeOptionalString<const T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  if (typeof value === 'string' && allowed.includes(value as T)) {
    return value as T
  }

  throw new TypeError(`Unexpected transmux core enum value: ${String(value)}.`)
}

function normalizeOptionalPrimitive<T extends 'string' | 'number'>(value: unknown, expectedType: T): (T extends 'string' ? string : number) | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  if (typeof value === expectedType) {
    return value as T extends 'string' ? string : number
  }

  throw new TypeError(`Expected optional ${expectedType}, received ${typeof value}.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
