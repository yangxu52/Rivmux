export function createMp4VideoMime(codec: string): string {
  return `video/mp4; codecs="${codec}"`
}

export function createMp4AudioMime(codec: string): string {
  return `audio/mp4; codecs="${codec}"`
}

export class MseUnsupportedMimeError extends Error {
  readonly mimeType: string

  constructor(mimeType: string) {
    super(`MSE does not support ${mimeType}.`)
    this.name = 'MseUnsupportedMimeError'
    this.mimeType = mimeType
  }
}

export function isMseSupported(mimeType: string): boolean {
  return typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function' && MediaSource.isTypeSupported(mimeType)
}

export function assertMseRuntimeSupport(): void {
  if (typeof MediaSource === 'undefined') {
    throw new Error('MediaSource is not available in this worker.')
  }

  if (MediaSource.canConstructInDedicatedWorker !== true) {
    throw new Error('MediaSource cannot be constructed in this dedicated worker.')
  }

  if (typeof MediaSource.isTypeSupported !== 'function') {
    throw new Error('MediaSource.isTypeSupported is not available in this worker.')
  }
}

export function assertMseSupport(mimeType: string): void {
  assertMseRuntimeSupport()
  if (!isMseSupported(mimeType)) {
    throw new MseUnsupportedMimeError(mimeType)
  }
}
