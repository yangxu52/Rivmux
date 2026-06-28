import { describe, expect, it, vi } from 'vitest'

import { SourceBufferQueue } from '../src/mse/source-buffer-queue'

import type { BufferedRange } from '../src/latency/buffer-ranges'

describe('SourceBufferQueue', () => {
  it('serializes append operations through updateend', async () => {
    const sourceBuffer = new MockSourceBuffer()
    const queue = new SourceBufferQueue(sourceBuffer as unknown as SourceBuffer)
    const first = new ArrayBuffer(1)
    const second = new ArrayBuffer(2)
    const appendDone = Promise.all([queue.append(first), queue.append(second)])

    await flushPromises()
    expect(sourceBuffer.appendBuffer).toHaveBeenCalledWith(first)
    expect(sourceBuffer.appendBuffer).toHaveBeenCalledTimes(1)

    sourceBuffer.finishUpdate()
    await flushPromises()
    expect(sourceBuffer.appendBuffer).toHaveBeenCalledWith(second)
    expect(sourceBuffer.appendBuffer).toHaveBeenCalledTimes(2)

    sourceBuffer.finishUpdate()
    await appendDone
    expect(queue.length).toBe(0)
  })

  it('queues cleanup removals before later appends', async () => {
    const sourceBuffer = new MockSourceBuffer([
      { start: 0, end: 1 },
      { start: 2, end: 5 },
    ])
    const queue = new SourceBufferQueue(sourceBuffer as unknown as SourceBuffer)
    const cleanupDone = queue.cleanupBefore(3.5)

    await flushPromises()
    expect(sourceBuffer.remove).toHaveBeenCalledWith(0, 1)
    sourceBuffer.finishUpdate()

    await flushPromises()
    expect(sourceBuffer.remove).toHaveBeenCalledWith(2, 3.5)
    sourceBuffer.finishUpdate()

    await cleanupDone
    expect(sourceBuffer.remove).toHaveBeenCalledTimes(2)
    expect(queue.bufferedDuration).toBe(4)
  })
})

class MockSourceBuffer {
  updating = false
  buffered: TimeRanges
  readonly appendBuffer = vi.fn(() => {
    this.updating = true
  })
  readonly remove = vi.fn(() => {
    this.updating = true
  })
  private readonly listeners = new Map<string, Set<EventListener>>()

  constructor(ranges: BufferedRange[] = []) {
    this.buffered = createTimeRanges(ranges)
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  finishUpdate(): void {
    this.updating = false
    for (const listener of this.listeners.get('updateend') ?? []) {
      listener(new Event('updateend'))
    }
  }
}

function createTimeRanges(ranges: readonly BufferedRange[]): TimeRanges {
  return {
    length: ranges.length,
    start: (index: number) => ranges[index]?.start ?? 0,
    end: (index: number) => ranges[index]?.end ?? 0,
  }
}

function flushPromises(): Promise<void> {
  return Promise.resolve()
}
