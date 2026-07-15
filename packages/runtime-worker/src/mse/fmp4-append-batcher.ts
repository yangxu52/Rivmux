import type { CoreMediaSegment } from '../wasm/rivmux-transmux-wasm'

type Track = CoreMediaSegment['track']

type PendingBatch = {
  readonly track: Track
  readonly dtsStartMs: number
  dtsEndMs: number
  readonly keyframe: boolean
  readonly parts: Uint8Array[]
  byteLength: number
}

export type Fmp4AppendBatcherOptions = {
  maxDurationMs?: number
  maxBytes?: number
}

export const DEFAULT_FMP4_APPEND_BATCH_DURATION_MS = 125
export const DEFAULT_FMP4_APPEND_BATCH_MAX_BYTES = 512 * 1024

export class Fmp4AppendBatcher {
  private readonly pending = new Map<Track, PendingBatch>()
  private readonly timers = new Map<Track, ReturnType<typeof setTimeout>>()
  private readonly maxDurationMs: number
  private readonly maxBytes: number
  private readonly onFlushDue: (track: Track) => void

  constructor(onFlushDue: (track: Track) => void, options: Fmp4AppendBatcherOptions = {}) {
    this.onFlushDue = onFlushDue
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_FMP4_APPEND_BATCH_DURATION_MS
    this.maxBytes = options.maxBytes ?? DEFAULT_FMP4_APPEND_BATCH_MAX_BYTES
  }

  push(segment: CoreMediaSegment): CoreMediaSegment | undefined {
    let batch = this.pending.get(segment.track)
    if (batch !== undefined && this.wouldExceedLimit(batch, segment)) {
      const flushed = this.flush(segment.track)
      batch = this.createBatch(segment)
      this.pending.set(segment.track, batch)
      this.scheduleFlush(segment.track)
      return flushed
    }

    if (batch === undefined) {
      batch = this.createBatch(segment)
      this.pending.set(segment.track, batch)
      this.scheduleFlush(segment.track)
    } else {
      batch.dtsEndMs = Math.max(batch.dtsEndMs, segment.dtsEndMs)
      batch.parts.push(segment.bytes)
      batch.byteLength += segment.bytes.byteLength
    }

    return batch.byteLength >= this.maxBytes ? this.flush(segment.track) : undefined
  }

  flush(track: Track): CoreMediaSegment | undefined {
    const batch = this.pending.get(track)
    if (batch === undefined) {
      return undefined
    }

    this.pending.delete(track)
    this.cancelFlush(track)
    return {
      track,
      dtsStartMs: batch.dtsStartMs,
      dtsEndMs: batch.dtsEndMs,
      keyframe: batch.keyframe,
      bytes: mergeBytes(batch.parts, batch.byteLength),
    }
  }

  flushAll(): CoreMediaSegment[] {
    const batches: CoreMediaSegment[] = []
    for (const track of [...this.pending.keys()]) {
      const batch = this.flush(track)
      if (batch !== undefined) {
        batches.push(batch)
      }
    }
    return batches
  }

  discard(): void {
    this.pending.clear()
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }

  private createBatch(segment: CoreMediaSegment): PendingBatch {
    return {
      track: segment.track,
      dtsStartMs: segment.dtsStartMs,
      dtsEndMs: segment.dtsEndMs,
      keyframe: segment.keyframe,
      parts: [segment.bytes],
      byteLength: segment.bytes.byteLength,
    }
  }

  private wouldExceedLimit(batch: PendingBatch, segment: CoreMediaSegment): boolean {
    const durationMs = Math.max(batch.dtsEndMs, segment.dtsEndMs) - batch.dtsStartMs
    return durationMs > this.maxDurationMs || batch.byteLength + segment.bytes.byteLength > this.maxBytes
  }

  private scheduleFlush(track: Track): void {
    this.timers.set(
      track,
      setTimeout(() => {
        this.timers.delete(track)
        this.onFlushDue(track)
      }, this.maxDurationMs)
    )
  }

  private cancelFlush(track: Track): void {
    const timer = this.timers.get(track)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(track)
    }
  }
}

function mergeBytes(parts: readonly Uint8Array[], byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}
