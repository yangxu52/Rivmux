import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRuntimeWorker } from '../src/index'

import type { NormalizedRivmuxPlayerOptions } from '@rivmux/protocol'

describe('createRuntimeWorker', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses an explicit worker URL while preserving module worker options', () => {
    const calls: Array<{ url: string | URL; options: WorkerOptions }> = []
    class MockWorker {
      constructor(url: string | URL, options: WorkerOptions) {
        calls.push({ url, options })
      }
    }
    vi.stubGlobal('Worker', MockWorker)

    const worker = createRuntimeWorker(createOptions({ preferWorkerMse: true, workerUrl: 'https://cdn.example.test/rivmux-runtime-worker.js' }))

    expect(worker).toBeInstanceOf(MockWorker)
    expect(calls).toStrictEqual([
      {
        url: 'https://cdn.example.test/rivmux-runtime-worker.js',
        options: {
          name: 'rivmux-runtime-worker',
          type: 'module',
        },
      },
    ])
  })
})

function createOptions(runtime: NormalizedRivmuxPlayerOptions['runtime']): NormalizedRivmuxPlayerOptions {
  return {
    playback: { autoPlay: true, muted: false },
    latency: { startupBuffer: 0.35, target: 1.2, max: 2.5, maxForwardBuffer: 4, backwardBuffer: 1.5 },
    network: { headers: {}, credentials: 'same-origin', retry: { maxAttempts: 3, backoffMs: 500 } },
    runtime,
    diagnostics: { statsIntervalMs: 1000, debug: false },
  }
}
