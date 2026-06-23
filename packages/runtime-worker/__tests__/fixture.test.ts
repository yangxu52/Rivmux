import { describe, expect, it } from 'vitest'

import { createM1StaticFmp4Fixture, M1_VIDEO_MIME } from '../src/fixtures/m1-static-fmp4'

describe('M1 static fMP4 fixture', () => {
  it('exposes known-good init and media segments', () => {
    const fixture = createM1StaticFmp4Fixture()

    expect(fixture.mimeType).toBe(M1_VIDEO_MIME)
    expect(fixture.codec).toBe('avc1.42C01E')
    expect(fixture.width).toBe(320)
    expect(fixture.height).toBe(240)
    expect(fixture.initSegment.byteLength).toBe(769)
    expect(fixture.mediaSegment.byteLength).toBe(28135)
    expect(readBoxType(fixture.initSegment)).toBe('ftyp')
    expect(readBoxType(fixture.mediaSegment)).toBe('moof')
  })
})

function readBoxType(buffer: ArrayBuffer): string {
  return String.fromCharCode(...new Uint8Array(buffer, 4, 4))
}
