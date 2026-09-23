// Synthetic HTTP-FLV builder for the WASM boundary benchmark.
//
// Mirrors `crates/transmux-core/benches/support/mod.rs` so the Rust and WASM
// suites describe the same stream shape.

const u24 = (value) => [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]

/** Valid AVCDecoderConfigurationRecord (Baseline 3.0, 320x240). */
export const MINIMAL_AVCC = new Uint8Array([1, 0x42, 0xe0, 0x1e, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0x00, 0x1e, 0x01, 0x00, 0x02, 0x68, 0xce])

/**
 * Wraps a payload in an FLV tag with a correct `PreviousTagSize`.
 */
export function rawTag(tagType, timestampMs, payload) {
  const out = new Uint8Array(11 + payload.length + 4)
  out[0] = tagType
  out.set(u24(payload.length), 1)
  out.set(u24(timestampMs & 0x00ffffff), 4)
  out[7] = (timestampMs >> 24) & 0xff
  out.set(payload, 11)
  new DataView(out.buffer).setUint32(11 + payload.length, 11 + payload.length)
  return out
}

/** Builds an FLV video tag carrying a length-prefixed AVC access unit. */
export function avcTag(timestampMs, isKeyframe, nal) {
  const payload = new Uint8Array(9 + nal.length)
  payload.set([isKeyframe ? 0x17 : 0x27, 1, 0, 0, 0])
  new DataView(payload.buffer).setUint32(5, nal.length)
  payload.set(nal, 9)
  return rawTag(9, timestampMs, payload)
}

/**
 * Builds an HTTP-FLV stream with a video sequence header followed by `frames`
 * length-prefixed AVC access units. The first frame is a keyframe; later frames
 * use a 33 ms cadence (30 fps).
 */
export function videoFlv(frames, frameBytes) {
  const parts = [new Uint8Array([0x46, 0x4c, 0x56, 1, 0x01, 0, 0, 0, 9, 0, 0, 0, 0])]

  const sequenceHeader = new Uint8Array(5 + MINIMAL_AVCC.length)
  sequenceHeader.set([0x17, 0, 0, 0, 0])
  sequenceHeader.set(MINIMAL_AVCC, 5)
  parts.push(rawTag(9, 0, sequenceHeader))

  const nal = new Uint8Array(frameBytes)
  nal.fill(0x41)
  nal[0] = 0x65
  for (let index = 0; index < frames; index += 1) {
    parts.push(avcTag(index * 33, index === 0, nal))
  }

  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
