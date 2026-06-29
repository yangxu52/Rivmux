import { createPlayerError } from './errors'

import type { PlayerError } from '@rivmux/protocol'

export const M1_VIDEO_MIME = 'video/mp4; codecs="avc1.42C01E"'

export function detectMainThreadRuntime(): PlayerError | undefined {
  if (typeof Worker === 'undefined') {
    return createPlayerError('unsupported', 'RIVMUX_UNSUPPORTED_WORKER', 'Dedicated Worker is not available in this runtime.', true)
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

  if (!MediaSource.isTypeSupported(M1_VIDEO_MIME)) {
    return createPlayerError('unsupported', 'RIVMUX_UNSUPPORTED_M1_VIDEO_MIME', `MSE does not support ${M1_VIDEO_MIME}.`, true)
  }

  return undefined
}
