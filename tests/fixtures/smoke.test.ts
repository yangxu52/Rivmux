import { describe, expect, it } from 'vitest'

import { createM1StaticFmp4Fixture, M1_VIDEO_MIME } from './m1-static-fmp4'

describe('test media fixtures', () => {
  it('owns the static M1 fMP4 fixture used by runtime and browser tests', () => {
    const fixture = createM1StaticFmp4Fixture()

    expect(fixture.mimeType).toBe(M1_VIDEO_MIME)
    expect(fixture.initSegment.byteLength).toBeGreaterThan(0)
    expect(fixture.mediaSegment.byteLength).toBeGreaterThan(0)
    expect(readBoxType(fixture.initSegment)).toBe('ftyp')
    expect(readBoxType(fixture.mediaSegment)).toBe('moof')
  })
})

function readBoxType(buffer: ArrayBuffer): string {
  return String.fromCharCode(...new Uint8Array(buffer, 4, 4))
}
