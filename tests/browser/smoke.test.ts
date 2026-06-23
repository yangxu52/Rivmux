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
  it('plays the static fMP4 fixture through the packaged worker path', async () => {
    await resetTestStreams()

    const video = createVideo()
    const player = createPlayer('m1-single')
    const errors: unknown[] = []
    const mediaInfo: unknown[] = []
    player.on('error', (error) => errors.push(error))
    player.on('mediaInfo', (info) => mediaInfo.push(info))

    try {
      const playable = waitForVideoPlayable(video)
      await player.attach(video)
      await player.start()
      await playable

      expect(errors).toStrictEqual([])
      expect(video.readyState).toBeGreaterThanOrEqual(HTMLMediaElement.HAVE_FUTURE_DATA)
      expect(mediaInfo).toContainEqual({
        container: 'fmp4',
        videoCodec: 'avc1.42C01E',
        width: 320,
        height: 240,
      })
    } finally {
      await player.destroy()
      video.remove()
    }
  })

  it('starts two independent instances and closes both HTTP-FLV streams', async () => {
    await resetTestStreams()

    const firstVideo = createVideo()
    const secondVideo = createVideo()
    const firstPlayer = createPlayer('m2-first')
    const secondPlayer = createPlayer('m2-second')

    try {
      const firstPlayable = waitForVideoPlayable(firstVideo)
      const secondPlayable = waitForVideoPlayable(secondVideo)

      await Promise.all([firstPlayer.attach(firstVideo), secondPlayer.attach(secondVideo)])
      await Promise.all([firstPlayer.start(), secondPlayer.start()])
      await Promise.all([firstPlayable, secondPlayable])

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

function createPlayer(streamId: string): RivmuxPlayer {
  return new RivmuxPlayer(new URL(`/__rivmux-test/stream/${streamId}.flv`, window.location.href).href, {
    playback: {
      autoPlay: true,
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

function waitForVideoPlayable(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for playable video. readyState=${video.readyState}`))
    }, 5_000)
    const cleanup = () => {
      window.clearTimeout(timeout)
      video.removeEventListener('canplay', onPlayable)
      video.removeEventListener('playing', onPlayable)
      video.removeEventListener('error', onError)
    }
    const onPlayable = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error(`Video error ${video.error?.code ?? 'unknown'}: ${video.error?.message ?? 'unknown'}`))
    }

    video.addEventListener('canplay', onPlayable, { once: true })
    video.addEventListener('playing', onPlayable, { once: true })
    video.addEventListener('error', onError, { once: true })
  })
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
