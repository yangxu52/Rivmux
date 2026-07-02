type TransmuxCoreWasmConstructor = new () => {
  pushChunk(chunk: Uint8Array): unknown
  flush(): unknown
  reset(): void
  destroy(): void
}

// eslint-disable-next-line
let wasm: TransmuxCoreWasmConstructor
export { wasm as TransmuxCore }
