type TransmuxCoreWasmConstructor = new () => {
  pushChunk(chunk: Uint8Array): unknown
  flush(): unknown
  reset(): void
  destroy(): void
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module

declare const TransmuxCore: TransmuxCoreWasmConstructor

export { TransmuxCore }

declare function initWasmCore(input?: InitInput | Promise<InitInput>): Promise<unknown>

export default initWasmCore
