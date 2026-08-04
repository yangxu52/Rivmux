import type { NormalizedNetworkOptions } from '@rivmux/protocol'

export type StreamChunk = {
  bytes: Uint8Array
  receivedAtMs: number
}

export type StreamLoaderStats = {
  bytesReceived: number
  currentNetworkSpeed: number
  contentLength?: number
  startedAtMs?: number
  lastChunkAtMs?: number
}

export type StreamLoaderConfig = {
  url: string
  network: NormalizedNetworkOptions
  fetch?: typeof fetch
  now?: () => number
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
}

export type StreamLoader = {
  readonly closed: boolean
  readonly paused: boolean
  readonly stats: StreamLoaderStats
  open(): Promise<void>
  read(): Promise<StreamChunk | null>
  pause(): void
  resume(): void
  close(): Promise<void>
}
