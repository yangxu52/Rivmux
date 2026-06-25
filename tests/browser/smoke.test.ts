import { describe, expect, it } from 'vitest'

import { RivmuxPlayer } from '../../packages/player/dist/index.js'

type TestStreamStats = Record<
  string,
  {
    active: boolean
    opened: number
    closed: number
    chunks: number
    bytes: number
  }
>

describe('Rivmux browser runtime', () => {
  it('loads the default packaged wasm transmux core and appends fMP4 segments from HTTP-FLV', async () => {
    await resetTestStreams()

    const video = createVideo()
    const player = createPlayer('m5-default-wasm', {
      autoPlay: false,
      fixture: 'h264',
    })
    const errors: unknown[] = []
    const mediaInfo: unknown[] = []
    const stats: unknown[] = []
    player.on('error', (error) => errors.push(error))
    player.on('mediaInfo', (info) => mediaInfo.push(info))
    player.on('stats', (entry) => stats.push(entry))

    try {
      await player.attach(video)
      await player.start()

      await waitForCoreSignal(errors, () => mediaInfo.some((info) => isRecord(info) && info.container === 'flv' && info.videoCodec === 'avc1.42C01E'))
      await waitForCoreSignal(errors, () => stats.some((entry) => isRecord(entry) && typeof entry.outputBytes === 'number' && entry.outputBytes > 0))
      expect(errors).toStrictEqual([])
      expect(mediaInfo).toContainEqual({
        container: 'flv',
        videoCodec: 'avc1.42C01E',
      })
      expect(stats).toContainEqual(
        expect.objectContaining({
          outputBytes: expect.any(Number),
        })
      )
    } finally {
      await player.destroy()
      video.remove()
    }
  })

  it('starts two independent instances and closes both HTTP-FLV streams', async () => {
    await resetTestStreams()

    const firstVideo = createVideo()
    const secondVideo = createVideo()
    const firstPlayer = createPlayer('m2-first', { fixture: 'h264' })
    const secondPlayer = createPlayer('m2-second', { fixture: 'h264' })

    try {
      await Promise.all([firstPlayer.attach(firstVideo), secondPlayer.attach(secondVideo)])
      await Promise.all([firstPlayer.start(), secondPlayer.start()])

      await waitForStreamState(['m2-first', 'm2-second'], (stats) => stats.every((state) => state.opened === 1 && state.active && state.chunks > 0))

      await firstPlayer.stop()
      await secondPlayer.destroy()

      await waitForStreamState(['m2-first', 'm2-second'], (stats) => stats.every((state) => state.closed === 1 && !state.active))
    } finally {
      await firstPlayer.destroy()
      await secondPlayer.destroy()
      firstVideo.remove()
      secondVideo.remove()
    }
  })
})

function createPlayer(streamId: string, options: { autoPlay?: boolean; fixture?: string } = {}): RivmuxPlayer {
  const url = new URL(`/__rivmux-test/stream/${streamId}.flv`, window.location.href)
  if (options.fixture !== undefined) {
    url.searchParams.set('fixture', options.fixture)
  }

  return new RivmuxPlayer(url.href, {
    playback: {
      autoPlay: options.autoPlay ?? true,
      muted: true,
    },
    network: {
      credentials: 'same-origin',
      retry: {
        maxAttempts: 1,
        backoffMs: 0,
      },
    },
  })
}

function createVideo(): HTMLVideoElement {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.controls = true
  document.body.append(video)
  return video
}

async function resetTestStreams(): Promise<void> {
  await fetch('/__rivmux-test/reset', { method: 'POST' })
}

async function readStreamStats(): Promise<TestStreamStats> {
  const response = await fetch('/__rivmux-test/stats', { cache: 'no-store' })
  const text = await response.text()
  if (!response.ok || text.length === 0) {
    throw new Error(`Failed to read test stream stats. status=${response.status} body=${text}`)
  }

  return JSON.parse(text) as TestStreamStats
}

async function waitForStreamState(ids: string[], predicate: (stats: TestStreamStats[string][]) => boolean): Promise<void> {
  await waitFor(async () => {
    const stats = await readStreamStats()
    const selected = ids.map((id) => stats[id])
    return selected.every((state) => state !== undefined) && predicate(selected)
  })
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await predicate()) {
      return
    }

    await new Promise((resolve) => window.setTimeout(resolve, 50))
  }

  throw new Error('Timed out waiting for condition.')
}

async function waitForCoreSignal(errors: unknown[], predicate: () => boolean | Promise<boolean>): Promise<void> {
  await waitFor(async () => {
    if (errors.length > 0) {
      throw new Error(`Worker emitted error: ${JSON.stringify(errors.at(-1))}`)
    }

    return predicate()
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
