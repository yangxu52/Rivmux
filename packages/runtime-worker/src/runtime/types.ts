import type { BufferedRange } from '../latency/buffer-ranges'
import type { StreamLoader, StreamLoaderConfig } from '../loader/loader'
import type { NormalizedRivmuxPlayerOptions, PlayerError, WorkerMessage } from '@rivmux/protocol'
import type { CoreEvent, TransmuxCoreHost } from '../wasm/rivmux-transmux-wasm'

export type RuntimeState = 'idle' | 'ready' | 'attached' | 'started' | 'stopped' | 'destroyed' | 'fatal-error'

export type RuntimeMseCleanupOptions = {
  force?: boolean
}

export type RuntimeWorkerPort = {
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void
  close(): void
}

export type RuntimeMseController = {
  readonly appendQueueLength: number
  readonly appendQueueBytes: number
  readonly sourceBufferUpdating: boolean
  readonly sourceBufferCount: number
  readonly bufferedStart: number | undefined
  readonly bufferedEnd: number | undefined
  readonly bufferedDuration: number | undefined
  readonly bufferedRanges: BufferedRange[]
  readonly bufferedRangeCount: number
  createMediaSourceHandle(): Promise<MediaSourceHandle>
  appendInitSegment(segment: Extract<CoreEvent, { type: 'initSegment' }>['data']): Promise<void>
  appendMediaSegment(segment: Extract<CoreEvent, { type: 'mediaSegment' }>['data']): Promise<void>
  cleanupBefore(cutoff: number, options?: RuntimeMseCleanupOptions): Promise<void>
  destroy(): void
}

export type RuntimeWorkerDependencies = {
  createMseController?: () => RuntimeMseController
  createLoader?: (config: StreamLoaderConfig) => StreamLoader
  createTransmuxCore?: (options: NormalizedRivmuxPlayerOptions) => TransmuxCoreHost | undefined | Promise<TransmuxCoreHost | undefined>
  detectRuntime?: () => PlayerError | undefined
  now?: () => number
}
