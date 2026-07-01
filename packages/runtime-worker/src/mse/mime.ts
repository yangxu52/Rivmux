export type RequiredMseMimeType = {
  readonly mediaType: 'video' | 'audio'
  readonly mimeType: string
  readonly unsupportedCode: string
}

export function createMp4VideoMime(codec: string): string {
  return `video/mp4; codecs="${codec}"`
}

export function createMp4AudioMime(codec: string): string {
  return `audio/mp4; codecs="${codec}"`
}

export const REQUIRED_MSE_MIME_TYPES = [
  {
    mediaType: 'video',
    mimeType: createMp4VideoMime('avc1.42C01E'),
    unsupportedCode: 'RIVMUX_UNSUPPORTED_MSE_VIDEO_MIME',
  },
  {
    mediaType: 'audio',
    mimeType: createMp4AudioMime('mp4a.40.2'),
    unsupportedCode: 'RIVMUX_UNSUPPORTED_MSE_AUDIO_MIME',
  },
] as const satisfies readonly RequiredMseMimeType[]

export function isMseSupported(mimeType: string): boolean {
  return typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function' && MediaSource.isTypeSupported(mimeType)
}

export function assertMseSupport(mimeType: string): void {
  if (typeof MediaSource === 'undefined') {
    throw new Error('MediaSource is not available in this worker.')
  }

  if (MediaSource.canConstructInDedicatedWorker !== true) {
    throw new Error('MediaSource cannot be constructed in this dedicated worker.')
  }

  if (!isMseSupported(mimeType)) {
    throw new Error(`MSE does not support ${mimeType}.`)
  }
}

export function assertRequiredMseSupport(): void {
  for (const requirement of REQUIRED_MSE_MIME_TYPES) {
    assertMseSupport(requirement.mimeType)
  }
}
