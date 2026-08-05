import { describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'

import { RivmuxPlayer } from '../../packages/player/dist/index.js'

describe.sequential('Rivmux autoplay policy in Chromium', () => {
  it('reports autoplay rejection and resumes after a real user gesture', async () => {
    const streamId = 'm1-s4-autoplay-rejected'
    await resetTestStream(streamId)

    const video = createVideo()
    const resumeButton = document.createElement('button')
    resumeButton.textContent = '恢复播放'
    document.body.append(resumeButton)
    const player = createPlayer(streamId)
    const errors: unknown[] = []
    const warnings: unknown[] = []
    const stats: unknown[] = []
    let manualPlay: Promise<void> | undefined
    player.on('error', (error) => errors.push(error))
    player.on('warning', (warning) => warnings.push(warning))
    player.on('stats', (entry) => stats.push(entry))
    resumeButton.addEventListener('click', () => {
      manualPlay = video.play()
    })

    try {
      await player.attach(video)
      await player.start()

      await waitForHealthySignal(errors, () =>
        warnings.some(
          (warning) => isRecord(warning) && warning.code === 'RIVMUX_AUTOPLAY_REJECTED' && isRecord(warning.cause) && warning.cause.name === 'NotAllowedError'
        )
      )
      await waitForHealthySignal(errors, () => stats.some((entry) => isNumberFieldAtLeast(entry, 'outputBytes', 1)))
      expect(warnings).toHaveLength(1)
      expect(video.paused).toBe(true)

      await userEvent.click(resumeButton)
      await waitFor(() => manualPlay !== undefined)
      await manualPlay
      await waitForHealthySignal(errors, () => video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !video.paused && video.currentTime >= 0.25)

      expect(warnings).toHaveLength(1)
      expect(errors).toStrictEqual([])
    } finally {
      await player.destroy()
      resumeButton.remove()
      video.remove()
    }
  })
})

function createPlayer(streamId: string): RivmuxPlayer {
  const url = new URL(`/__rivmux-test/stream/${streamId}.flv`, window.location.href)
  url.searchParams.set('fixture', 'h264-aac-playable')

  return new RivmuxPlayer(url.href, {
    playback: {
      autoPlay: true,
      muted: false,
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
  video.muted = false
  video.playsInline = true
  document.body.append(video)
  return video
}

async function resetTestStream(streamId: string): Promise<void> {
  const url = new URL('/__rivmux-test/reset', window.location.href)
  url.searchParams.set('id', streamId)
  await fetch(url, { method: 'POST' })
}

async function waitForHealthySignal(errors: unknown[], predicate: () => boolean | Promise<boolean>): Promise<void> {
  await waitFor(async () => {
    if (errors.length > 0) {
      throw new Error(`Worker emitted error: ${JSON.stringify(errors.at(-1))}`)
    }

    return predicate()
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNumberFieldAtLeast(value: unknown, field: string, minimum: number): boolean {
  return isRecord(value) && typeof value[field] === 'number' && value[field] >= minimum
}
