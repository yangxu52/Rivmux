import { createPlayerError } from './errors'

import type { PlayerError } from '@rivmux/protocol'

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

  return undefined
}
