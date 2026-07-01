import { afterEach, describe, expect, it, vi } from 'vitest'

import { REQUIRED_MSE_MIME_TYPES, detectMainThreadRuntime } from '../src/feature-detect'

describe('detectMainThreadRuntime', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requires fetch support before worker initialization', () => {
    vi.stubGlobal('Worker', class MockWorker {})
    vi.stubGlobal('fetch', undefined)

    expect(detectMainThreadRuntime()).toMatchObject({
      kind: 'unsupported',
      code: 'RIVMUX_UNSUPPORTED_FETCH',
      terminal: true,
    })
  })

  it('requires configured MSE MIME support', () => {
    const videoRequirement = requireMseRequirement('video')
    const audioRequirement = requireMseRequirement('audio')
    vi.stubGlobal('Worker', class MockWorker {})
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('ReadableStream', class MockReadableStream {})
    vi.stubGlobal('WebAssembly', {})
    vi.stubGlobal('MediaSource', {
      canConstructInDedicatedWorker: true,
      isTypeSupported: vi.fn((mime: string) => mime === videoRequirement.mimeType),
    })

    expect(detectMainThreadRuntime()).toMatchObject({
      kind: 'unsupported',
      code: audioRequirement.unsupportedCode,
      message: `MSE does not support ${audioRequirement.mimeType}.`,
      terminal: true,
    })
  })
})

function requireMseRequirement(mediaType: (typeof REQUIRED_MSE_MIME_TYPES)[number]['mediaType']): (typeof REQUIRED_MSE_MIME_TYPES)[number] {
  const requirement = REQUIRED_MSE_MIME_TYPES.find((entry) => entry.mediaType === mediaType)
  if (requirement === undefined) {
    throw new Error(`Missing ${mediaType} MIME requirement.`)
  }

  return requirement
}
