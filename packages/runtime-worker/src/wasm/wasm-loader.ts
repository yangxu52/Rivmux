import { WasmTransmuxCoreHost } from './rivmux-transmux-wasm'

import type { TransmuxCoreHost, TransmuxCoreWasmConstructor } from './rivmux-transmux-wasm'

export type CreateTransmuxCoreHost = () => TransmuxCoreHost | undefined | Promise<TransmuxCoreHost | undefined>

type WasmBindgenModule = {
  default: (input?: string | URL | Request | Response | BufferSource | WebAssembly.Module) => Promise<unknown>
  TransmuxCore: TransmuxCoreWasmConstructor
}

export function createWasmTransmuxCoreHost(Core: TransmuxCoreWasmConstructor | undefined): TransmuxCoreHost | undefined {
  return Core === undefined ? undefined : new WasmTransmuxCoreHost(Core)
}

export async function loadWasmTransmuxCoreHost(wasmUrl: string | undefined): Promise<TransmuxCoreHost | undefined> {
  if (wasmUrl === undefined) {
    return undefined
  }

  const module = await nativeDynamicImport(toWasmBindgenGlueUrl(wasmUrl))
  const wasmModule = normalizeWasmBindgenModule(module)
  await wasmModule.default(wasmUrl)
  return new WasmTransmuxCoreHost(wasmModule.TransmuxCore)
}

export function toWasmBindgenGlueUrl(wasmUrl: string): string {
  const url = new URL(wasmUrl, globalThis.location?.href ?? 'http://localhost/')
  const path = url.pathname
  const nextPath = path.endsWith('_bg.wasm') ? `${path.slice(0, -'_bg.wasm'.length)}.js` : path.replace(/\.wasm$/u, '.js')
  url.pathname = nextPath
  return url.href
}

function normalizeWasmBindgenModule(value: unknown): WasmBindgenModule {
  if (!isRecord(value) || typeof value.default !== 'function' || typeof value.TransmuxCore !== 'function') {
    throw new TypeError('WASM transmux module must export default init and TransmuxCore.')
  }

  return value as WasmBindgenModule
}

function nativeDynamicImport(url: string): Promise<unknown> {
  const importer = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>
  return importer(url)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
