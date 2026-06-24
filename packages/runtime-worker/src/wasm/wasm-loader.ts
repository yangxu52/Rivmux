import { WasmTransmuxCoreHost } from './rivmux-transmux-wasm'

import type { TransmuxCoreHost, TransmuxCoreWasmConstructor } from './rivmux-transmux-wasm'

export type CreateTransmuxCoreHost = () => TransmuxCoreHost | undefined

export function createWasmTransmuxCoreHost(Core: TransmuxCoreWasmConstructor | undefined): TransmuxCoreHost | undefined {
  return Core === undefined ? undefined : new WasmTransmuxCoreHost(Core)
}
