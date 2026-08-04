import { describe, expect, it } from 'vitest'

import { RivmuxPlayer } from '../../packages/player/dist/index.js'

import type { MediaInfo, PlayerError, PlayerStats, ReconnectInfo, RecoveryInfo } from '../../packages/player/dist/index.js'

type TestStreamConnectionStats = {
  sequence: number
  active: boolean
  chunks: number
  bytes: number
  closed: boolean
}

type TestStreamState = {
  active: boolean
  opened: number
  closed: number
  chunks: number
  bytes: number
  connections: TestStreamConnectionStats[]
}

type TestStreamStats = Record<string, TestStreamState>

type RecoveryEvents = {
  errors: PlayerError[]
  mediaInfo: MediaInfo[]
  reconnecting: ReconnectInfo[]
  recovered: RecoveryInfo[]
  stats: PlayerStats[]
}

type RecoveryPlayerOptions = {
  readIdleTimeoutMs: number
  maxAttempts: number
  backoffMs: number
}

describe.sequential('Rivmux live recovery in Chromium', () => {
  it('recovers after the first HTTP-FLV connection ends after its first media segment', async () => {
    const streamId = 'm1-s1-unexpected-eof'
    await resetTestStreams(streamId)
    const video = createVideo()
    const player = createRecoveryPlayer(streamId, {
      readIdleTimeoutMs: 5_000,
      maxAttempts: 3,
      backoffMs: 100,
    })
    const events = observeRecovery(player)

    try {
      await player.attach(video)
      await player.start()
      await waitForInitialMedia(streamId, events)

      await endStreamConnection(streamId, 1)
      await waitForHealthyRecovery(streamId, events, 'unexpected-eof')

      const stream = await readStreamState(streamId)
      expect(events.reconnecting).toStrictEqual([
        {
          attempt: 2,
          maxAttempts: 3,
          delayMs: 100,
          reason: 'unexpected-eof',
        },
      ])
      expect(events.recovered).toStrictEqual([
        {
          attempt: 2,
          downtimeMs: expect.any(Number),
        },
      ])
      expect(terminalErrors(events)).toStrictEqual([])
      expect(stream.opened).toBe(2)
      expect(findConnection(stream, 1)).toMatchObject({ active: false, closed: true })
      expect(findConnection(stream, 2)).toMatchObject({ active: true, closed: false, chunks: 1 })
      expect(findConnection(stream, 2)?.bytes).toBeGreaterThan(0)
    } finally {
      await player.destroy()
      video.remove()
    }
  })

  it('recovers after an active HTTP-FLV connection remains permanently idle', async () => {
    const streamId = 'm1-s1-read-timeout'
    await resetTestStreams(streamId)
    const video = createVideo()
    const player = createRecoveryPlayer(streamId, {
      readIdleTimeoutMs: 600,
      maxAttempts: 3,
      backoffMs: 50,
    })
    const events = observeRecovery(player)

    try {
      await player.attach(video)
      await player.start()
      await waitForInitialMedia(streamId, events)
      await waitForHealthyRecovery(streamId, events, 'read-timeout')

      const stream = await readStreamState(streamId)
      expect(events.reconnecting[0]).toStrictEqual({
        attempt: 2,
        maxAttempts: 3,
        delayMs: 50,
        reason: 'read-timeout',
      })
      expect(events.recovered).toStrictEqual([
        {
          attempt: 2,
          downtimeMs: expect.any(Number),
        },
      ])
      expect(terminalErrors(events)).toStrictEqual([])
      expect(stream.opened).toBeGreaterThanOrEqual(2)
      expect(findConnection(stream, 1)).toMatchObject({ active: false, closed: true })
      expect(findConnection(stream, 2)?.bytes).toBeGreaterThan(0)
    } finally {
      await player.destroy()
      video.remove()
    }
  })

  it.each(['stop', 'destroy'] as const)('cancels a reconnect backoff when %s is called', async (action) => {
    const streamId = `m1-s1-cancel-${action}`
    await resetTestStreams(streamId)
    const video = createVideo()
    const backoffMs = 750
    const player = createRecoveryPlayer(streamId, {
      readIdleTimeoutMs: 5_000,
      maxAttempts: 3,
      backoffMs,
    })
    const events = observeRecovery(player)

    try {
      await player.attach(video)
      await player.start()
      await waitForInitialMedia(streamId, events)
      await endStreamConnection(streamId, 1)
      await waitForRecoverySignal(events, () => events.reconnecting.length === 1)

      expect(events.reconnecting).toStrictEqual([
        {
          attempt: 2,
          maxAttempts: 3,
          delayMs: backoffMs,
          reason: 'unexpected-eof',
        },
      ])

      if (action === 'stop') {
        await player.stop()
      } else {
        await player.destroy()
      }

      await waitForStreamState(streamId, (stream) => {
        const firstConnection = findConnection(stream, 1)
        return stream.opened === 1 && stream.active === false && firstConnection?.active === false && firstConnection.closed
      })
      await delay(backoffMs + 250)

      const stream = await readStreamState(streamId)
      expect(stream.opened).toBe(1)
      expect(stream.active).toBe(false)
      expect(findConnection(stream, 1)).toMatchObject({ active: false, closed: true })
      expect(terminalErrors(events)).toStrictEqual([])
      expect(events.recovered).toStrictEqual([])
    } finally {
      await player.destroy()
      video.remove()
    }
  })
})

function createRecoveryPlayer(streamId: string, options: RecoveryPlayerOptions): RivmuxPlayer {
  const url = new URL(`/__rivmux-test/stream/${encodeURIComponent(streamId)}.flv`, window.location.href)
  url.searchParams.set('fixture', 'h264-aac')

  return new RivmuxPlayer(url.href, {
    playback: {
      autoPlay: false,
      muted: true,
    },
    network: {
      credentials: 'same-origin',
      readIdleTimeoutMs: options.readIdleTimeoutMs,
      retry: {
        maxAttempts: options.maxAttempts,
        backoffMs: options.backoffMs,
        maxBackoffMs: options.backoffMs,
        jitterRatio: 0,
      },
    },
    diagnostics: {
      statsIntervalMs: 50,
    },
  })
}

function observeRecovery(player: RivmuxPlayer): RecoveryEvents {
  const events: RecoveryEvents = {
    errors: [],
    mediaInfo: [],
    reconnecting: [],
    recovered: [],
    stats: [],
  }
  player.on('error', (error) => events.errors.push(error))
  player.on('mediaInfo', (info) => events.mediaInfo.push(info))
  player.on('reconnecting', (info) => events.reconnecting.push(info))
  player.on('recovered', (info) => events.recovered.push(info))
  player.on('stats', (stats) => events.stats.push(stats))
  return events
}

function createVideo(): HTMLVideoElement {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  document.body.append(video)
  return video
}

async function waitForInitialMedia(streamId: string, events: RecoveryEvents): Promise<void> {
  await waitForRecoverySignal(events, async () => {
    const stream = await readStreamStateIfAvailable(streamId)
    if (stream === undefined) {
      return false
    }
    const firstConnection = findConnection(stream, 1)
    return (
      events.mediaInfo.length > 0 &&
      events.stats.some(({ outputBytes }) => outputBytes > 0) &&
      stream.opened === 1 &&
      firstConnection?.active === true &&
      firstConnection.chunks > 0 &&
      firstConnection.bytes > 0
    )
  })
}

async function waitForHealthyRecovery(streamId: string, events: RecoveryEvents, reason: ReconnectInfo['reason']): Promise<void> {
  try {
    await waitForRecoverySignal(events, async () => {
      const stream = await readStreamStateIfAvailable(streamId)
      if (stream === undefined) {
        return false
      }
      const secondConnection = findConnection(stream, 2)
      return (
        events.reconnecting.some((info) => info.reason === reason) &&
        events.recovered.length === 1 &&
        stream.opened >= 2 &&
        secondConnection?.active === true &&
        secondConnection.chunks > 0 &&
        secondConnection.bytes > 0
      )
    })
  } catch (cause) {
    const stream = await readStreamStateIfAvailable(streamId)
    throw new Error(
      `Recovery did not complete. reconnecting=${JSON.stringify(events.reconnecting)} recovered=${JSON.stringify(events.recovered)} mediaInfo=${events.mediaInfo.length} outputSignals=${events.stats.filter(({ outputBytes }) => outputBytes > 0).length} stream=${JSON.stringify(stream)}`,
      { cause }
    )
  }
}

async function endStreamConnection(streamId: string, connection: number): Promise<void> {
  const url = new URL(`/__rivmux-test/stream/${encodeURIComponent(streamId)}/control`, window.location.href)
  url.searchParams.set('action', 'end')
  url.searchParams.set('connection', String(connection))
  const response = await fetch(url, { method: 'POST' })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`Failed to end test stream connection. status=${response.status} body=${body}`)
  }
}

async function resetTestStreams(...streamIds: string[]): Promise<void> {
  const url = new URL('/__rivmux-test/reset', window.location.href)
  for (const streamId of streamIds) {
    url.searchParams.append('id', streamId)
  }
  const response = await fetch(url, { method: 'POST' })
  if (!response.ok) {
    throw new Error(`Failed to reset test streams. status=${response.status}`)
  }
}

async function readStreamState(streamId: string): Promise<TestStreamState> {
  const stream = await readStreamStateIfAvailable(streamId)
  if (stream === undefined) {
    throw new Error(`Test stream state is unavailable for ${streamId}.`)
  }
  return stream
}

async function readStreamStateIfAvailable(streamId: string): Promise<TestStreamState | undefined> {
  const response = await fetch('/__rivmux-test/stats', { cache: 'no-store' })
  const body = await response.text()
  if (!response.ok || body.length === 0) {
    throw new Error(`Failed to read test stream stats. status=${response.status} body=${body}`)
  }

  return (JSON.parse(body) as TestStreamStats)[streamId]
}

async function waitForStreamState(streamId: string, predicate: (stream: TestStreamState) => boolean): Promise<void> {
  await waitFor(async () => predicate(await readStreamState(streamId)))
}

async function waitForRecoverySignal(events: RecoveryEvents, predicate: () => boolean | Promise<boolean>): Promise<void> {
  await waitFor(async () => {
    const terminal = terminalErrors(events).at(-1)
    if (terminal !== undefined) {
      throw new Error(`Worker emitted terminal error: ${JSON.stringify(terminal)}`)
    }
    return predicate()
  })
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await predicate()) {
      return
    }
    await delay(25)
  }

  throw new Error('Timed out waiting for condition.')
}

function findConnection(stream: TestStreamState, sequence: number): TestStreamConnectionStats | undefined {
  return stream.connections.find((connection) => connection.sequence === sequence)
}

function terminalErrors(events: RecoveryEvents): PlayerError[] {
  return events.errors.filter(({ terminal }) => terminal)
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs))
}
