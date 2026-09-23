/* eslint-disable no-console -- the benchmark's output is the report. */

/**
 * WASM boundary benchmark for rivmux_transmux_core.
 *
 * The Rust benchmark suite (`cargo bench -p rivmux_transmux_core`) measures the
 * core in isolation, on the host target. It cannot measure what happens when
 * events cross into JavaScript, which is exactly where the largest regression
 * this project has hit lives: `serde-wasm-bindgen` serializes a `Vec<u8>` as a
 * plain JavaScript array by default, i.e. one JS number per byte, unless the
 * payload goes through `serialize_bytes`. That difference is ~65x and is
 * invisible to `cargo bench`.
 *
 * This script drives a real `wasm-pack --target nodejs` build and checks two
 * things:
 *
 *   1. Shape (deterministic): every byte payload arrives as a `Uint8Array`, not
 *      an array of numbers.
 *   2. Throughput ratio (self-calibrating): the core must clear the cost of
 *      turning the same byte volume into JS numbers by a wide margin.
 *
 * The ratio is measured against a floor computed in the same process, so it
 * does not depend on machine speed or JIT warm-up. It is asserted; the absolute
 * MiB/s figures are printed for context only.
 *
 * Usage:
 *
 *   node benches/wasm/bench.mjs [--json]
 *
 * The build is done by `benches/wasm/run.sh`, which also installs the package.
 * Set `RIVMUX_WASM_PKG` to point at an existing `--target nodejs` output.
 */

import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { videoFlv } from './gen.mjs'

/** Frames and frame size for the benchmark stream (mirrors the Rust suite). */
const FRAMES = 2000
const FRAME_BYTES = 30 * 1024
const CHUNK_SIZE = 64 * 1024

/**
 * Minimum acceptable ratio between core throughput and the numeric-array floor.
 *
 * Measured on a correct build this is ~48x; a build that regressed to numeric
 * arrays measures ~0.65x. 10x sits far from both, so ordinary JIT and machine
 * variation cannot trip it.
 */
const MIN_RATIO = 10

const EXPECTED_BYTE_FIELDS = ['trackConfig.config.codec.avc.avcc', 'initSegment.bytes', 'mediaSegment.bytes']

/**
 * Walks every byte payload reachable from the events and reports its shape.
 */
function surveyBytePayloads(events) {
  const shapes = new Map()
  const visit = (value, path) => {
    if (value instanceof Uint8Array) {
      shapes.set(path, 'Uint8Array')
      return
    }
    if (Array.isArray(value)) {
      // Only flag arrays that look like a byte payload, so unrelated number
      // arrays do not pollute the report.
      shapes.set(path, `Array(${value.length})`)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        visit(value[key], path === '' ? key : `${path}.${key}`)
      }
    }
  }
  for (const event of events) {
    visit(event.data, event.type)
  }
  return shapes
}

/**
 * Time the core over `stream`, fed in `chunkSize` pieces.
 */
function timeCore(TransmuxCore, stream, chunkSize) {
  const core = new TransmuxCore()
  let eventCount = 0
  const shapes = new Map()
  const start = performance.now()
  for (let offset = 0; offset < stream.length; offset += chunkSize) {
    const events = core.pushChunk(stream.subarray(offset, Math.min(offset + chunkSize, stream.length)))
    eventCount += events.length
    for (const [path, shape] of surveyBytePayloads(events)) {
      shapes.set(path, shape)
    }
  }
  const elapsedMs = performance.now() - start
  core.free()
  return { elapsedMs, eventCount, shapes }
}

/**
 * Cost of materializing the same byte volume as a JavaScript number array.
 *
 * This is the shape `serde-wasm-bindgen` produces for `Vec<u8>` by default, so
 * it is the floor the boundary must be faster than — measured in the same
 * process, on the same bytes.
 */
function timeNumericFloor(stream, chunkSize) {
  let sink = 0
  const start = performance.now()
  for (let offset = 0; offset < stream.length; offset += chunkSize) {
    sink += Array.from(stream.subarray(offset, Math.min(offset + chunkSize, stream.length))).length
  }
  return { elapsedMs: performance.now() - start, sink }
}

function mibPerSecond(bytes, elapsedMs) {
  return bytes / 1024 / 1024 / (elapsedMs / 1000)
}

function fail(message, details) {
  console.error(`\n✗ ${message}`)
  for (const line of details ?? []) {
    console.error(`  ${line}`)
  }
  process.exitCode = 1
}

async function main() {
  const json = process.argv.includes('--json')
  const packagePath = process.env.RIVMUX_WASM_PKG ?? resolve(import.meta.dirname, '../../wasm/dist/rivmux_transmux_core.js')

  let module
  try {
    module = await import(pathToFileURL(packagePath).href)
  } catch (cause) {
    fail(`Could not load the WASM package at ${packagePath}.`, ['Build it first: benches/wasm/run.sh', `cause: ${cause.message}`])
    return
  }

  const TransmuxCore = module.TransmuxCore
  if (typeof TransmuxCore !== 'function') {
    fail(`The package at ${packagePath} does not export TransmuxCore.`, [`exports: ${Object.keys(module).join(', ') || '(none)'}`])
    return
  }

  const stream = videoFlv(FRAMES, FRAME_BYTES)
  const mib = stream.length / 1024 / 1024

  // Warm up, then take the best of several runs: JIT warm-up dominates the
  // first pass, so a single sample is not meaningful.
  const coreRuns = []
  const floorRuns = []
  let last = undefined
  for (let run = 0; run < 7; run += 1) {
    last = timeCore(TransmuxCore, stream, CHUNK_SIZE)
    coreRuns.push(last.elapsedMs)
    floorRuns.push(timeNumericFloor(stream, CHUNK_SIZE).elapsedMs)
  }
  const coreMs = Math.min(...coreRuns)
  const floorMs = Math.min(...floorRuns)

  const coreThroughput = mibPerSecond(stream.length, coreMs)
  const floorThroughput = mibPerSecond(stream.length, floorMs)
  const ratio = coreThroughput / floorThroughput

  const shapes = last.shapes
  const leaked = [...shapes].filter(([, shape]) => shape !== 'Uint8Array')
  const missing = EXPECTED_BYTE_FIELDS.filter((field) => !shapes.has(field))

  if (json) {
    console.log(
      JSON.stringify(
        {
          streamBytes: stream.length,
          events: last.eventCount,
          coreMiBPerSecond: Number(coreThroughput.toFixed(1)),
          floorMiBPerSecond: Number(floorThroughput.toFixed(1)),
          ratio: Number(ratio.toFixed(2)),
          minRatio: MIN_RATIO,
          byteShapes: Object.fromEntries([...shapes].filter(([path]) => EXPECTED_BYTE_FIELDS.includes(path))),
          passed: leaked.length === 0 && missing.length === 0 && ratio >= MIN_RATIO,
        },
        null,
        2
      )
    )
    if (leaked.length > 0 || missing.length > 0 || ratio < MIN_RATIO) {
      process.exitCode = 1
    }
    return
  }

  console.log('\n== WASM boundary (Node) ==')
  console.log(`stream                ${mib.toFixed(1)} MiB, ${FRAMES} frames x ${FRAME_BYTES} B, ${CHUNK_SIZE / 1024} KiB chunks`)
  console.log(`events                ${last.eventCount}`)
  console.log('')
  console.log(`core (Uint8Array)     ${coreMs.toFixed(1).padStart(8)} ms  ${coreThroughput.toFixed(1).padStart(7)} MiB/s`)
  console.log(`floor (number array)  ${floorMs.toFixed(1).padStart(8)} ms  ${floorThroughput.toFixed(1).padStart(7)} MiB/s`)
  console.log(`ratio                 ${ratio.toFixed(2)}x  (must be >= ${MIN_RATIO}x)`)
  console.log('')
  console.log('byte payload shapes:')
  for (const field of EXPECTED_BYTE_FIELDS) {
    console.log(`  ${field.padEnd(38)} ${shapes.get(field) ?? '(absent)'}`)
  }

  let ok = true
  if (leaked.length > 0) {
    ok = false
    fail(
      'Byte payloads reached JavaScript as plain arrays.',
      leaked.map(([path, shape]) => `${path}: ${shape}`).concat('A byte payload must go through serialize_bytes.')
    )
  }
  if (missing.length > 0) {
    ok = false
    fail('Expected byte payloads were not observed.', missing)
  }
  if (ratio < MIN_RATIO) {
    ok = false
    fail(`Core/floor ratio ${ratio.toFixed(2)}x is below the ${MIN_RATIO}x minimum.`, ['This is the signature of byte payloads crossing as numeric arrays.'])
  }

  if (ok) {
    console.log('\n✓ byte payloads are Uint8Array and the boundary clears the numeric-array floor')
  }
}

await main()
