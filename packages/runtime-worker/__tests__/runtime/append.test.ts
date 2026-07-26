import { describe, expect, it, vi } from 'vitest'

import { RuntimeAppendController } from '../../src/runtime/append'

import type { LifecycleCommandContext } from '../../src/runtime/lifecycle'
import type { CoreMediaSegment } from '../../src/wasm/rivmux-transmux-wasm'

describe('RuntimeAppendController', () => {
  it('does not append batches queued before discard', async () => {
    const appendToMse = vi.fn(async () => true)
    const context = lifecycleContext()
    const controller = new RuntimeAppendController({
      appendToMse,
      isStarted: () => true,
      isLifecycleContextCurrent: () => true,
      onAppended: async () => undefined,
      onError: vi.fn(),
    })

    controller.start(context)
    controller.push(mediaSegment(), context)
    const pending = controller.push({ ...mediaSegment(), dtsStartMs: 130, dtsEndMs: 150 }, context)
    expect(pending).toBeDefined()
    controller.discard()

    await pending
    expect(appendToMse).not.toHaveBeenCalled()
  })
})

function lifecycleContext(): LifecycleCommandContext {
  return { generation: 0, signal: new AbortController().signal }
}

function mediaSegment(): CoreMediaSegment {
  return {
    track: 'video',
    dtsStartMs: 0,
    dtsEndMs: 20,
    keyframe: true,
    bytes: new Uint8Array([1]),
  }
}
