import { describe, expect, it } from 'vitest'

import { RuntimeWorker } from '../src/runtime'

import type { NormalizedRivmuxPlayerOptions, WorkerMessage } from 'rivmux-protocol'

describe('RuntimeWorker', () => {
  it('emits ready after init', async () => {
    const port = new MockPort()
    const runtime = new RuntimeWorker(port)

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })

    expect(port.messages).toStrictEqual([{ type: 'ready' }])
  })

  it('rejects start before attach with a terminal structured error', async () => {
    const port = new MockPort()
    const runtime = new RuntimeWorker(port)

    await runtime.handleCommand({ type: 'init', id: 'player-1', url: 'https://example.test/live.flv', options: createOptions() })
    await runtime.handleCommand({ type: 'start' })

    expect(port.messages.at(-1)).toStrictEqual({
      type: 'error',
      error: {
        kind: 'runtime',
        code: 'RIVMUX_WORKER_START_REQUIRES_ATTACH',
        message: 'Worker start requires an attached MediaSource.',
        terminal: true,
      },
    })
  })
})

class MockPort {
  readonly messages: WorkerMessage[] = []

  postMessage(message: WorkerMessage): void {
    this.messages.push(message)
  }

  close(): void {}
}

function createOptions(): NormalizedRivmuxPlayerOptions {
  return {
    playback: { autoPlay: true, muted: false },
    latency: { startupBuffer: 0.35, target: 1.2, max: 2.5, maxForwardBuffer: 4, backwardBuffer: 1.5 },
    network: { headers: {}, credentials: 'same-origin', retry: { maxAttempts: 3, backoffMs: 500 } },
    runtime: { preferWorkerMse: true },
    diagnostics: { statsIntervalMs: 1000, debug: false },
  }
}
