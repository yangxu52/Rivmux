export const M1_VIDEO_MIME = 'video/mp4; codecs="avc1.42C01E"'

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
