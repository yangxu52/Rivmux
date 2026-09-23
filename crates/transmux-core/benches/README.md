# Transmux Core Benchmarks

Throughput benchmarks for the `rivmux_transmux_core` hot path: HTTP-FLV parsing,
codec normalization (AVC/HEVC/AAC), timestamp normalization and fMP4 muxing.

These are deliberately dependency free. The workspace keeps a small lockfile, and
the behaviour that matters here — buffer draining, payload copies and per-sample
allocations — is stable enough to measure with a plain warmup loop, so no
benchmark framework is pulled in.

## Running

```sh
cargo bench -p rivmux_transmux_core       # or: pnpm --filter @rivmux/transmux-core run bench
crates/transmux-core/benches/wasm/run.sh  # or: pnpm --filter @rivmux/transmux-core run bench:wasm
```

`cargo bench` measures the core natively. The second command builds a
`wasm-pack --target nodejs` package and drives it from Node, because the WASM
boundary cannot be measured on the host target (see below).

Groups can be selected by substring, which is handy while iterating on one hot
path:

```sh
cargo bench -p rivmux_transmux_core -- demuxer
cargo bench -p rivmux_transmux_core -- sample
```

The bench target sets `harness = false`, so the output is a plain measurement
table rather than libtest's `median`/`change` report. Cargo passes its own
`--bench` flag to the binary, so the group filter is resolved as the first
argument that is not a flag; libtest flags such as `--nocapture` are tolerated.

## Method

- Each group runs the workload twice untimed (warmup) and then seven timed
  iterations. The reported figure is the **fastest** iteration, which is the
  least noisy estimator for a deterministic workload.
- `bench=release` inherits the release profile (`opt-level = "z"`, `lto = true`).
  That is the profile shipped to WASM, so the numbers track production codegen
  rather than a `-O3` you never build.
- Every sample creates a fresh `TransmuxCore`, matching the runtime reset that
  happens on reconnect.
- Streams are synthetic FLV built in `benches/support/mod.rs`, so the input
  shape is explicit and no binary fixtures are checked in.
- `std::hint::black_box` keeps construction from being optimized away.

## Two layers, one gap

`cargo bench` runs on the host target, so it cannot observe what happens when
events cross into JavaScript. The dominant regression this project has hit
lives exactly there: `serde-wasm-bindgen` serializes a `Vec<u8>` as a plain
JavaScript array by default -- one JS number per byte -- unless the payload goes
through `serialize_bytes`.

| Layer         | Tool            | Guards                                     |
| ------------- | --------------- | ------------------------------------------ |
| Rust core     | `cargo bench`   | demuxer, codecs, muxer, allocations        |
| WASM boundary | `benches/wasm/` | byte payload shape and boundary throughput |

The layers are complementary, not interchangeable. The Rust-side
`serde_util::tests::codec_configuration_bytes_use_serialize_bytes` guard checks
the _mechanism_ (that `serialize_bytes` is called) but cannot express the
magnitude; only a real JS runtime can.

## Groups

| Group        | What it isolates                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------ |
| demuxer      | Parser buffer handling across whole-buffer / 64 KiB / 16 KiB / 4 KiB / 1 KiB / 256 B chunk sizes |
| sample       | Cost of `CoreEvent::Sample` (deep payload copy) via `emit_samples` on/off                        |
| tags         | Many small interleaved AAC+AVC tags, the audio-heavy live-stream shape                           |
| hevc         | HEVC access-unit split and re-serialization                                                      |
| construction | Cold `TransmuxCore::new` cost paid on attach/reconnect                                           |

## WASM boundary (Node)

`benches/wasm/run.sh` (or `pnpm --filter @rivmux/transmux-core run bench:wasm`)
builds a nodejs-target package into `crates/transmux-core/wasm/dist` and drives
it. It asserts two things and reports the numbers either way:

1. **Shape** -- `trackConfig.config.codec.avc.avcc`, `initSegment.bytes` and
   `mediaSegment.bytes` must arrive as `Uint8Array`. This is deterministic.
2. **Ratio** -- core throughput divided by the cost of materializing the same
   byte volume as JS numbers, measured in the same process. That self-contained
   floor makes the ratio independent of machine speed and JIT state. The minimum
   is **10x**.

Measured on a correct build the ratio is ~78x; a build that regressed to numeric
arrays measures ~0.65x, so the threshold sits far from both. The shape assertion
catches the regression first, and the ratio confirms it is not merely cosmetic.

Absolute MiB/s figures are printed for context only and are **not** comparable to
the `cargo bench` rows: the WASM build uses `--no-opt` by default and runs under
Node's JIT. Set `RIVMUX_WASM_RELEASE=1` to build with `wasm-opt -O4`.

Use `--json` for machine-readable output; build output goes to stderr so stdout
stays pipeable.

## Baseline (reference machine)

Rust 1.98 stable, `x86_64`, default features, `cargo bench`. Absolute numbers
are machine-specific; the ratios and the chunk-size curve are the meaningful
part.

| Benchmark                                    | Time    | Throughput |
| -------------------------------------------- | ------- | ---------- |
| demuxer whole (10 MiB)                       | 21.9 ms | 442 MiB/s  |
| demuxer 64 KiB                               | 7.4 ms  | 1310 MiB/s |
| demuxer 16 KiB                               | 7.1 ms  | 1351 MiB/s |
| demuxer 4 KiB                                | 7.2 ms  | 1337 MiB/s |
| demuxer 1 KiB                                | 7.5 ms  | 1283 MiB/s |
| demuxer 256 B                                | 8.4 ms  | 1149 MiB/s |
| sample channel `emit_samples=true` (60 MiB)  | 13.3 ms | 4314 MiB/s |
| sample channel `emit_samples=false` (60 MiB) | 11.0 ms | 5198 MiB/s |
| mixed tags 64 KiB (~7 MiB, 60k tags)         | 57.0 ms | 122 MiB/s  |
| mixed tags 16 KiB                            | 57.8 ms | 120 MiB/s  |
| mixed tags 4 KiB                             | 58.0 ms | 120 MiB/s  |
| HEVC normalization (40 MiB)                  | 8.7 ms  | 4394 MiB/s |
| construct ×10 000                            | 0.25 ms | —          |

## Regression coverage

The `demuxer` group is a direct guard for the FLV parser's buffer strategy.
Before the front-draining buffer was replaced with a read cursor, pushing the
stream as a single chunk re-copied the remaining buffer per tag and cost
**4118 ms** for 10 MiB (~2.3 MiB/s). The same case now runs in ~22 ms, and the
whole-buffer row stays flat instead of degrading with chunk size.
