# Transmux Core Benchmarks

Throughput benchmarks for the `rivmux_transmux_core` hot path: HTTP-FLV parsing,
codec normalization (AVC/HEVC/AAC), timestamp normalization and fMP4 muxing.

These are deliberately dependency free. The workspace keeps a small lockfile, and
the behaviour that matters here — buffer draining, payload copies and per-sample
allocations — is stable enough to measure with a plain warmup loop, so no
benchmark framework is pulled in.

## Running

```sh
cargo bench -p rivmux_transmux_core      # or: pnpm --filter @rivmux/transmux-core run bench
```

Groups can be selected by substring, which is handy while iterating on one hot
path:

```sh
cargo bench -p rivmux_transmux_core -- demuxer
cargo bench -p rivmux_transmux_core -- sample
```

The bench target sets `harness = false`, so the output is a plain measurement
table rather than libtest's `median`/`change` report.

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

This measures the **Rust core**. It does not measure the WASM boundary
(`serde_wasm_bindgen` serialization), which needs a Node driver against a
`wasm-pack --target nodejs` build.

## Groups

| Group        | What it isolates                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------ |
| demuxer      | Parser buffer handling across whole-buffer / 64 KiB / 16 KiB / 4 KiB / 1 KiB / 256 B chunk sizes |
| sample       | Cost of `CoreEvent::Sample` (deep payload copy) via `emit_samples` on/off                        |
| tags         | Many small interleaved AAC+AVC tags, the audio-heavy live-stream shape                           |
| hevc         | HEVC access-unit split and re-serialization                                                      |
| construction | Cold `TransmuxCore::new` cost paid on attach/reconnect                                           |

## Baseline (reference machine)

Rust 1.98 stable, `x86_64`, default features, `cargo bench`. Absolute numbers
are machine-specific; the ratios and the chunk-size curve are the meaningful
part.

| Benchmark                                    | Time    | Throughput |
| -------------------------------------------- | ------- | ---------- |
| demuxer whole (10 MiB)                       | 21.5 ms | 449 MiB/s  |
| demuxer 64 KiB                               | 7.2 ms  | 1335 MiB/s |
| demuxer 16 KiB                               | 7.1 ms  | 1358 MiB/s |
| demuxer 4 KiB                                | 7.3 ms  | 1324 MiB/s |
| demuxer 1 KiB                                | 7.8 ms  | 1245 MiB/s |
| demuxer 256 B                                | 8.2 ms  | 1179 MiB/s |
| sample channel `emit_samples=true` (60 MiB)  | 13.1 ms | 4368 MiB/s |
| sample channel `emit_samples=false` (60 MiB) | 11.0 ms | 5215 MiB/s |
| mixed tags 64 KiB (~7 MiB, 60k tags)         | 56.6 ms | 122 MiB/s  |
| mixed tags 16 KiB                            | 57.6 ms | 120 MiB/s  |
| mixed tags 4 KiB                             | 57.9 ms | 120 MiB/s  |
| HEVC normalization (40 MiB)                  | 8.4 ms  | 4569 MiB/s |
| construct ×10 000                            | 0.25 ms | —          |

## Regression coverage

The `demuxer` group is a direct guard for the FLV parser's buffer strategy.
Before the front-draining buffer was replaced with a read cursor, pushing the
stream as a single chunk re-copied the remaining buffer per tag and cost
**4118 ms** for 10 MiB (~2.3 MiB/s). The same case now runs in ~22 ms, and the
whole-buffer row stays flat instead of degrading with chunk size.
