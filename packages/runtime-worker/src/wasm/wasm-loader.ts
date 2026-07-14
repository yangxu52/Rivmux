import { WasmTransmuxCoreHost } from './rivmux-transmux-wasm'
import initBundledTransmuxCore, { TransmuxCore as BundledTransmuxCore } from '@rivmux/transmux-core'

import type { TransmuxCoreHost, TransmuxCoreWasmConstructor } from './rivmux-transmux-wasm'

export function createWasmTransmuxCoreHost(Core: TransmuxCoreWasmConstructor | undefined): TransmuxCoreHost {
  if (Core === undefined) {
    throw new TypeError('WASM transmux core constructor is not available.')
  }

  return new WasmTransmuxCoreHost(Core)
}

export async function loadWasmTransmuxCoreHost(wasmUrl: string | undefined): Promise<TransmuxCoreHost> {
  const source = wasmUrl ?? new URL('./rivmux-transmux-core.wasm', import.meta.url)
  await initBundledTransmuxCore(source)
  return createWasmTransmuxCoreHost(BundledTransmuxCore)
}
