import { createPlayerError } from './errors'

import type { PlayerError } from '@rivmux/protocol'

export type RequiredMseMimeType = {
  readonly mediaType: 'video' | 'audio'
  readonly mimeType: string
  readonly unsupportedCode: string
}

export const REQUIRED_MSE_MIME_TYPES = [
  {
    mediaType: 'video',
    mimeType: createMp4Mime('video', 'avc1.42C01E'),
    unsupportedCode: 'RIVMUX_UNSUPPORTED_MSE_VIDEO_MIME',
  },
  {
    mediaType: 'audio',
    mimeType: createMp4Mime('audio', 'mp4a.40.2'),
    unsupportedCode: 'RIVMUX_UNSUPPORTED_MSE_AUDIO_MIME',
  },
] as const satisfies readonly RequiredMseMimeType[]

export function detectMainThreadRuntime(): PlayerError | undefined {
  if (typeof Worker === 'undefined') {
    return createPlayerError('unsupported', 'RIVMUX_UNSUPPORTED_WORKER', 'Dedicated Worker is not available in this runtime.', true)
  }

  if (typeof fetch !== 'function') {
    return createPlayerError('unsupported', 'RIVMUX_UNSUPPORTED_FETCH', 'Fetch is not available in this runtime.', true)
  }

  if (typeof ReadableStream === 'undefined') {
    return createPlayerError('unsupported', 'RIVMUX_UNSUPPORTED_READABLE_STREAM', 'ReadableStream is not available in this runtime.', true)
  }

  if (typeof WebAssembly === 'undefined') {
    return createPlayerError('unsupported', 'RIVMUX_UNSUPPORTED_WASM', 'WebAssembly is not available in this runtime.', true)
  }

  if (typeof MediaSource === 'undefined') {
    return createPlayerError('unsupported', 'RIVMUX_UNSUPPORTED_MSE', 'MediaSource is not available in this runtime.', true)
  }

  if (MediaSource.canConstructInDedicatedWorker !== true) {
    return createPlayerError('unsupported', 'RIVMUX_UNSUPPORTED_WORKER_MSE', 'MediaSource cannot be constructed in a dedicated worker in this runtime.', true)
  }

  if (typeof MediaSource.isTypeSupported !== 'function') {
    return createPlayerError('unsupported', 'RIVMUX_UNSUPPORTED_MSE_TYPE_CHECK', 'MediaSource.isTypeSupported is not available in this runtime.', true)
  }

  for (const requirement of REQUIRED_MSE_MIME_TYPES) {
    if (!MediaSource.isTypeSupported(requirement.mimeType)) {
      return createPlayerError('unsupported', requirement.unsupportedCode, `MSE does not support ${requirement.mimeType}.`, true)
    }
  }

  return undefined
}

function createMp4Mime(mediaType: RequiredMseMimeType['mediaType'], codec: string): string {
  return `${mediaType}/mp4; codecs="${codec}"`
}
