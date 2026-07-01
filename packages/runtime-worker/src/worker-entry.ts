import { RuntimeWorker } from './runtime'

import type { WorkerCommand, WorkerMessage } from '@rivmux/protocol'

export { RuntimeWorker } from './runtime'
export { HttpFlvLoader, HttpFlvLoaderError } from './loader/http-flv-loader'
export { MseController } from './mse/mse-controller'
export { SourceBufferQueue } from './mse/source-buffer-queue'
export { M1_VIDEO_MIME, isMseSupported } from './mse/mime'
export { WasmTransmuxCoreHost, normalizeCoreEvents } from './wasm/rivmux-transmux-wasm'
export { createWasmTransmuxCoreHost } from './wasm/wasm-loader'
export type { StreamChunk, StreamLoader, StreamLoaderConfig, StreamLoaderStats } from './loader/loader'
export type { CoreEvent, TransmuxCoreHost, TransmuxCoreWasmConstructor } from './wasm/rivmux-transmux-wasm'

type DedicatedWorkerScopeLike = {
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerCommand>) => void): void
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void
  close(): void
}

export function startRuntimeWorker(scope: DedicatedWorkerScopeLike): RuntimeWorker {
  const runtime = new RuntimeWorker({
    postMessage: (message, transfer) => scope.postMessage(message, transfer),
    close: () => scope.close(),
  })

  scope.addEventListener('message', (event) => {
    void runtime.handleCommand(event.data)
  })
  scope.postMessage({ type: 'worker-ready' })

  return runtime
}

const globalScope = globalThis as typeof globalThis & Partial<DedicatedWorkerScopeLike>
const workerGlobalScope = (globalThis as typeof globalThis & { WorkerGlobalScope?: { new (): unknown } }).WorkerGlobalScope

if (workerGlobalScope !== undefined && globalScope instanceof workerGlobalScope && typeof globalScope.postMessage === 'function') {
  startRuntimeWorker(globalScope as DedicatedWorkerScopeLike)
}
