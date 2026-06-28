type TransmuxCoreWasmConstructor = new () => {
  pushChunk(chunk: Uint8Array): unknown
  flush(): unknown
  reset(): void
  destroy(): void
}

let wasm: TransmuxCoreWasmConstructor
export { wasm as TransmuxCore }
