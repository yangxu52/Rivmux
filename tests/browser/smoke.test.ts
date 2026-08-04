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
  it('loads the default packaged wasm transmux core and appends H.264/AAC fMP4 segments from HTTP-FLV', async () => {
    await resetTestStreams('m5-default-wasm')

    const video = createVideo()
    const player = createPlayer('m5-default-wasm', {
      fixture: 'h264-aac-playable',
    })
    const errors: unknown[] = []
    const mediaInfo: unknown[] = []
    const stats: unknown[] = []
    player.on('error', (error) => errors.push(error))
    player.on('mediaInfo', (info) => mediaInfo.push(info))
    player.on('stats', (entry) => stats.push(entry))
    let canPlay = false
    video.addEventListener(
      'canplay',
      () => {
        canPlay = true
      },
      { once: true }
    )

    try {
      await player.attach(video)
      await player.start()

      await waitForCoreSignal(errors, () =>
        mediaInfo.some((info) => isRecord(info) && info.container === 'flv' && info.videoCodec === 'avc1.42C01E' && info.audioCodec === 'mp4a.40.2')
      )
      await waitForCoreSignal(errors, () => stats.some((entry) => isRecord(entry) && typeof entry.outputBytes === 'number' && entry.outputBytes > 0))
      await waitForCoreSignal(errors, () => canPlay)
      await waitForPlayback(errors, video)
      expect(errors).toStrictEqual([])
      expect(mediaInfo).toContainEqual(
        expect.objectContaining({
          container: 'flv',
          videoCodec: 'avc1.42C01E',
          audioCodec: 'mp4a.40.2',
          audioSampleRate: 44_100,
          audioChannelCount: 2,
        })
      )
      expect(stats).toContainEqual(
        expect.objectContaining({
          outputBytes: expect.any(Number),
        })
      )
      expect(video.readyState).toBeGreaterThanOrEqual(HTMLMediaElement.HAVE_FUTURE_DATA)
      expect(video.currentTime).toBeGreaterThanOrEqual(0.25)
    } finally {
      await player.destroy()
      video.remove()
    }
  })

  it('appends Opus fMP4 segments from Enhanced FLV', async () => {
    await resetTestStreams('opus-enhanced-flv')

    const video = createVideo()
    const player = createPlayer('opus-enhanced-flv', {
      autoPlay: false,
      fixture: 'opus',
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

      await waitForCoreSignal(errors, () => mediaInfo.some((info) => isRecord(info) && info.container === 'flv' && info.audioCodec === 'opus'))
      await waitForCoreSignal(errors, () => stats.some((entry) => isNumberFieldAtLeast(entry, 'outputBytes', 1)))
      expect(errors).toStrictEqual([])
      expect(mediaInfo).toContainEqual(
        expect.objectContaining({
          container: 'flv',
          audioCodec: 'opus',
          audioSampleRate: 48_000,
          audioChannelCount: 1,
        })
      )
    } finally {
      await player.destroy()
      video.remove()
    }
  })

  it('keeps one SourceBuffer when AAC configuration arrives after video samples', async () => {
    await resetTestStreams('m5-late-aac-config')

    const video = createVideo()
    const player = createPlayer('m5-late-aac-config', {
      autoPlay: false,
      fixture: 'h264-aac-late-config',
    })
    const errors: unknown[] = []
    const stats: unknown[] = []
    player.on('error', (error) => errors.push(error))
    player.on('stats', (entry) => stats.push(entry))

    try {
      await player.attach(video)
      await player.start()

      await waitForCoreSignal(errors, () => stats.some((entry) => isNumberFieldAtLeast(entry, 'outputBytes', 1)))
      expect(errors).toStrictEqual([])
      expect(stats).toContainEqual(
        expect.objectContaining({
          sourceBufferCount: 1,
        })
      )
    } finally {
      await player.destroy()
      video.remove()
    }
  })

  it('plays two independent instances and keeps one advancing after destroying the other', async () => {
    await resetTestStreams('m2-first', 'm2-second')

    const firstVideo = createVideo()
    const secondVideo = createVideo()
    const firstPlayer = createPlayer('m2-first', { fixture: 'h264-aac-playable' })
    const secondPlayer = createPlayer('m2-second', { fixture: 'h264-aac-playable' })
    const errors: unknown[] = []
    firstPlayer.on('error', (error) => errors.push(error))
    secondPlayer.on('error', (error) => errors.push(error))

    try {
      await Promise.all([firstPlayer.attach(firstVideo), secondPlayer.attach(secondVideo)])
      await Promise.all([firstPlayer.start(), secondPlayer.start()])

      await waitForStreamState(['m2-first', 'm2-second'], (stats) => stats.every((state) => state.opened === 1 && state.active && state.chunks > 0))
      await Promise.all([waitForPlayback(errors, firstVideo), waitForPlayback(errors, secondVideo)])

      await firstPlayer.destroy()
      const secondTime = secondVideo.currentTime
      await waitForPlayback(errors, secondVideo, secondTime)

      await waitForStreamState(['m2-first', 'm2-second'], ([first, second]) => first?.closed === 1 && !first.active && second?.opened === 1 && second.active)
      expect(errors).toStrictEqual([])
    } finally {
      await firstPlayer.destroy()
      await secondPlayer.destroy()
      firstVideo.remove()
      secondVideo.remove()
    }
  })

  it('stops and restarts the same player with a fresh playable HTTP-FLV stream', async () => {
    await resetTestStreams('m2-restart')

    const video = createVideo()
    const player = createPlayer('m2-restart', { fixture: 'h264-aac-playable' })
    const errors: unknown[] = []
    player.on('error', (error) => errors.push(error))

    try {
      await player.attach(video)
      await player.start()
      await waitForPlayback(errors, video)

      await player.stop()
      await waitForStreamState(['m2-restart'], ([state]) => state?.opened === 1 && state.closed === 1 && !state.active)
      expect(video.srcObject).toBeNull()

      await player.start()
      await waitForStreamState(['m2-restart'], ([state]) => state?.opened === 2 && state.active)
      const restartTime = video.currentTime
      await waitForPlayback(errors, video, restartTime)

      await player.destroy()
      await waitForStreamState(['m2-restart'], ([state]) => state?.opened === 2 && state.closed === 2 && !state.active)
      expect(errors).toStrictEqual([])
    } finally {
      await player.destroy()
      video.remove()
    }
  })

  it('recovers after a short HTTP-FLV read stall and exposes network idle stats', async () => {
    await resetTestStreams('m7-stall')

    const video = createVideo()
    const player = createPlayer('m7-stall', {
      autoPlay: false,
      fixture: 'h264-aac',
      stallMs: 250,
      statsIntervalMs: 50,
    })
    const errors: unknown[] = []
    const stats: unknown[] = []
    player.on('error', (error) => errors.push(error))
    player.on('stats', (entry) => stats.push(entry))

    try {
      await player.attach(video)
      await player.start()

      await waitForStreamState(['m7-stall'], ([state]) => state !== undefined && state.active && state.chunks === 1)
      await waitForCoreSignal(errors, () => stats.some((entry) => isNumberFieldAtLeast(entry, 'networkIdleMs', 100)))
      await waitForCoreSignal(errors, () => stats.some((entry) => isNumberFieldAtLeast(entry, 'outputBytes', 1)))
      await waitForStreamState(['m7-stall'], ([state]) => state !== undefined && state.chunks >= 2 && state.bytes > 0)

      expect(errors).toStrictEqual([])
    } finally {
      await player.destroy()
      video.remove()
    }
  })

  it('starts a small grid, receives playback signals, and destroys tiles independently', async () => {
    await resetTestStreams('m7-grid-a', 'm7-grid-b', 'm7-grid-c')

    const ids = ['m7-grid-a', 'm7-grid-b', 'm7-grid-c']
    const videos = ids.map(() => createVideo())
    const players = ids.map((id) => createPlayer(id, { fixture: 'h264', statsIntervalMs: 100 }))
    const errors = ids.map((): unknown[] => [])
    const allErrors: unknown[] = []
    const mediaInfo = ids.map((): unknown[] => [])
    const stats = ids.map((): unknown[] => [])

    players.forEach((player, index) => {
      player.on('error', (error) => {
        errors[index]?.push(error)
        allErrors.push(error)
      })
      player.on('mediaInfo', (info) => mediaInfo[index]?.push(info))
      player.on('stats', (entry) => stats[index]?.push(entry))
    })

    try {
      await Promise.all(players.map((player, index) => player.attach(videos[index] as HTMLVideoElement)))
      await Promise.all(players.map((player) => player.start()))

      await waitForCoreSignal(allErrors, () => ids.every((_, index) => mediaInfo[index]?.some((info) => isRecord(info) && info.container === 'flv') === true))
      await waitForCoreSignal(allErrors, () => ids.every((_, index) => stats[index]?.some((entry) => isNumberFieldAtLeast(entry, 'outputBytes', 1)) === true))
      await waitForStreamState(ids, (states) => states.every((state) => state.opened === 1 && state.active && state.chunks > 0))

      await players[1]?.destroy()
      await waitForStreamState(ids, (states) => !states[1]?.active && states[1]?.closed === 1 && states[0]?.active === true && states[2]?.active === true)

      expect(errors).toStrictEqual([[], [], []])
    } finally {
      await Promise.all(players.map((player) => player.destroy()))
      videos.forEach((video) => video.remove())
    }
  })

  it('emits a structured network error for HTTP failures in Chromium', async () => {
    await resetTestStreams('m7-network-error')

    const video = createVideo()
    const player = createPlayer('m7-network-error', { status: 503 })
    const errors: unknown[] = []
    player.on('error', (error) => errors.push(error))

    try {
      await player.attach(video)
      await player.start()

      await waitFor(async () =>
        errors.some((error) => isRecord(error) && error.kind === 'network' && error.code === 'RIVMUX_RECONNECT_EXHAUSTED' && error.terminal === true)
      )
    } finally {
      await player.destroy()
      video.remove()
    }
  })
})

function createPlayer(
  streamId: string,
  options: { autoPlay?: boolean; fixture?: string; stallMs?: number; status?: number; statsIntervalMs?: number } = {}
): RivmuxPlayer {
  const url = new URL(`/__rivmux-test/stream/${streamId}.flv`, window.location.href)
  if (options.fixture !== undefined) {
    url.searchParams.set('fixture', options.fixture)
  }
  if (options.stallMs !== undefined) {
    url.searchParams.set('stallMs', String(options.stallMs))
  }
  if (options.status !== undefined) {
    url.searchParams.set('status', String(options.status))
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
    diagnostics: {
      ...(options.statsIntervalMs === undefined ? {} : { statsIntervalMs: options.statsIntervalMs }),
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

async function resetTestStreams(...streamIds: string[]): Promise<void> {
  const url = new URL('/__rivmux-test/reset', window.location.href)
  for (const streamId of streamIds) {
    url.searchParams.append('id', streamId)
  }
  await fetch(url, { method: 'POST' })
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

async function waitForPlayback(errors: unknown[], video: HTMLVideoElement, initialTime = 0): Promise<void> {
  await waitForCoreSignal(errors, () => video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !video.paused && video.currentTime >= initialTime + 0.25)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNumberFieldAtLeast(value: unknown, field: string, minimum: number): boolean {
  return isRecord(value) && typeof value[field] === 'number' && value[field] >= minimum
}
