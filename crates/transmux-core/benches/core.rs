//! Transmux core throughput benchmarks.
//!
//! Run with:
//!
//! ```sh
//! cargo bench -p rivmux_transmux_core
//! ```
//!
//! Each group isolates one hot path so a regression in the demuxer, the
//! timestamp normalizer, the muxer or the codec normalizers shows up as a
//! distinct number rather than a single blended figure.

mod support;

use rivmux_transmux_core::{CoreConfig, TransmuxCore};
use support::{Measurement, measure_core, mixed_flv, video_flv};

/// Chunk sizes exercised by the demuxer group.
///
/// The runtime feeds the core whatever the network delivers, so chunk size is
/// the dominant input-shape variable for the parser's buffer handling. The
/// spread walks from a single whole-buffer push down to byte-scale trickle;
/// `16 KiB` is the granularity the browser test server chunks fixtures at.
const CHUNK_SIZES: [usize; 6] = [usize::MAX, 64 * 1024, 16 * 1024, 4 * 1024, 1024, 256];

fn chunk_label(chunk_size: usize) -> String {
    if chunk_size == usize::MAX {
        "whole".to_string()
    } else if chunk_size >= 1024 {
        format!("{} KiB", chunk_size / 1024)
    } else {
        format!("{chunk_size} B")
    }
}

fn measure_at(stream: &[u8], chunk_size: usize, config: &CoreConfig, name: &str) -> Measurement {
    let measurement = measure_core(stream, chunk_size, config);
    measurement.report(name);
    measurement
}

/// Demuxer and parser: same stream, varying chunk size.
///
/// A front-draining buffer degrades super-linearly as chunks grow, so the
/// `whole` and `64 KiB` rows are the ones to watch.
fn bench_demuxer_chunk_sizes() {
    println!("\n== demuxer: chunk size sweep (10 MiB, 5000 frames x 2000 B) ==");
    let stream = video_flv(5000, 2000);
    let config = CoreConfig::default();

    for chunk_size in CHUNK_SIZES {
        measure_at(
            &stream,
            chunk_size,
            &config,
            &format!("demuxer {}", chunk_label(chunk_size)),
        );
    }
}

/// Full pipeline with the per-sample event channel enabled and disabled.
///
/// The delta is the cost of emitting `CoreEvent::Sample` (a deep payload copy)
/// on every sample.
fn bench_sample_event_cost() {
    println!("\n== sample event channel (60 MiB, 2000 frames x 30000 B) ==");
    let stream = video_flv(2000, 30_000);

    for emit_samples in [true, false] {
        let config = CoreConfig {
            emit_samples,
            ..CoreConfig::default()
        };
        measure_at(
            &stream,
            64 * 1024,
            &config,
            &format!("emit_samples={emit_samples}"),
        );
    }
}

/// Many small tags, the shape of an audio-heavy live stream.
fn bench_many_small_tags() {
    println!("\n== many small tags (60k pairs, ~7 MiB) ==");
    let stream = mixed_flv(30_000, 200);
    let config = CoreConfig {
        emit_samples: false,
        ..CoreConfig::default()
    };

    for chunk_size in [64 * 1024, 16 * 1024, 4096] {
        measure_at(
            &stream,
            chunk_size,
            &config,
            &format!("mixed tags {}", chunk_label(chunk_size)),
        );
    }
}

/// HEVC normalization, where access units are split and re-serialized.
fn bench_hevc_normalization() {
    println!("\n== HEVC access unit normalization (40 MiB, 2000 frames) ==");
    let stream = support::hevc_flv(2000, 20_000, &support::minimal_hvcc());
    let config = CoreConfig {
        emit_samples: false,
        ..CoreConfig::default()
    };

    measure_at(&stream, 64 * 1024, &config, "hevc");
}

/// Cost of a cold `TransmuxCore` construction, which the runtime pays on every
/// attach and reconnect.
fn bench_construction() {
    println!("\n== core construction ==");
    let config = CoreConfig::default();
    const CONSTRUCTIONS: usize = 10_000;

    let mut best = std::time::Duration::MAX;
    for _ in 0..7 {
        let start = std::time::Instant::now();
        for _ in 0..CONSTRUCTIONS {
            std::hint::black_box(TransmuxCore::new(config.clone()));
        }
        best = best.min(start.elapsed());
    }
    println!(
        "{:<46} {:>9.3} ms  ({} constructions)",
        format!("construct x{CONSTRUCTIONS}"),
        best.as_secs_f64() * 1_000.0,
        CONSTRUCTIONS
    );
}

fn main() {
    // An optional substring argument selects groups, so a single hot path can
    // be iterated on without paying for the whole suite:
    //
    //   cargo bench -p rivmux_transmux_core -- demuxer
    let filter = std::env::args().nth(1);
    let wants = |group: &str| {
        filter
            .as_deref()
            .is_none_or(|filter| group.contains(filter))
    };

    if wants("demuxer") {
        bench_demuxer_chunk_sizes();
    }
    if wants("sample") {
        bench_sample_event_cost();
    }
    if wants("tags") {
        bench_many_small_tags();
    }
    if wants("hevc") {
        bench_hevc_normalization();
    }
    if wants("construction") {
        bench_construction();
    }
}
