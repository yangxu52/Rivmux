import { RuntimeWorker } from './runtime'

import type { WorkerCommand } from 'rivmux-protocol'

export { RuntimeWorker } from './runtime'
export { M1_VIDEO_MIME, createM1StaticFmp4Fixture } from './fixtures/m1-static-fmp4'
export { HttpFlvLoader, HttpFlvLoaderError } from './loader/http-flv-loader'
export { MseController } from './mse/mse-controller'
export { SourceBufferQueue } from './mse/source-buffer-queue'
export { isMseSupported } from './mse/mime'
export type { StreamChunk, StreamLoader, StreamLoaderConfig, StreamLoaderStats } from './loader/loader'

type DedicatedWorkerScopeLike = {
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerCommand>) => void): void
  postMessage(message: unknown, transfer?: Transferable[]): void
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

  return runtime
}

const globalScope = globalThis as typeof globalThis & Partial<DedicatedWorkerScopeLike>
const workerGlobalScope = (globalThis as typeof globalThis & { WorkerGlobalScope?: { new (): unknown } }).WorkerGlobalScope

if (workerGlobalScope !== undefined && globalScope instanceof workerGlobalScope && typeof globalScope.postMessage === 'function') {
  startRuntimeWorker(globalScope as DedicatedWorkerScopeLike)
}
