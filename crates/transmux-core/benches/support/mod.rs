//! Shared helpers for transmux benchmarks.
//!
//! The harness is intentionally dependency free: the workspace keeps a small
//! lockfile, and the behaviour we care about (buffer draining, payload copies
//! and per-sample allocations) is stable enough to measure with a plain
//! warmup loop.

#![allow(
    dead_code,
    reason = "benchmarks compile this module separately for each bench target"
)]

use rivmux_transmux_core::{CoreConfig, TransmuxCore};
use std::time::{Duration, Instant};

/// Timed iterations per measurement. Each sample runs the whole workload, so
/// the reported minimum is the closest estimate of the true cost.
const ITERATIONS: usize = 7;
const WARMUP_ITERATIONS: usize = 2;

/// A single benchmark result.
#[derive(Debug, Clone, Copy)]
pub struct Measurement {
    pub duration: Duration,
    pub input_bytes: usize,
    pub events: usize,
}

impl Measurement {
    /// Throughput in mebibytes per second.
    #[must_use]
    pub fn throughput_mib_s(self) -> f64 {
        let seconds = self.duration.as_secs_f64();
        if seconds <= 0.0 {
            return f64::INFINITY;
        }
        (self.input_bytes as f64 / (1024.0 * 1024.0)) / seconds
    }

    /// Prints the measurement in a benchmark-friendly format.
    pub fn report(self, name: &str) {
        println!(
            "{name:<46} {:>9.3} ms  {:>10.1} MiB/s  events={}",
            self.duration.as_secs_f64() * 1_000.0,
            self.throughput_mib_s(),
            self.events,
        );
    }
}

/// Runs `workload` over `stream` with a warmup phase and reports the fastest run.
///
/// `workload` receives the whole stream and returns how many events it observed.
pub fn measure_stream(stream: &[u8], mut workload: impl FnMut(&[u8]) -> usize) -> Measurement {
    for _ in 0..WARMUP_ITERATIONS {
        workload(stream);
    }

    let mut best = Duration::MAX;
    let mut events = 0;
    for _ in 0..ITERATIONS {
        let start = Instant::now();
        events = workload(stream);
        best = best.min(start.elapsed());
    }

    Measurement {
        duration: best,
        input_bytes: stream.len(),
        events,
    }
}

/// Runs `workload` over `stream` split into fixed-size chunks.
///
/// Chunk size is the dominant input-shape variable for the demuxer, so this
/// mirrors how the runtime feeds the core from a `ReadableStream`.
pub fn measure_chunked(
    stream: &[u8],
    chunk_size: usize,
    mut workload: impl FnMut(&[u8]) -> usize,
) -> Measurement {
    let run = |stream: &[u8], workload: &mut dyn FnMut(&[u8]) -> usize| {
        let mut events = 0;
        for chunk in stream.chunks(chunk_size) {
            events += workload(chunk);
        }
        events
    };

    for _ in 0..WARMUP_ITERATIONS {
        run(stream, &mut workload);
    }

    let mut best = Duration::MAX;
    let mut events = 0;
    for _ in 0..ITERATIONS {
        let start = Instant::now();
        events = run(stream, &mut workload);
        best = best.min(start.elapsed());
    }

    Measurement {
        duration: best,
        input_bytes: stream.len(),
        events,
    }
}

/// Runs the full core pipeline over `stream` at a fixed chunk size and returns
/// the fastest measurement.
///
/// A fresh `TransmuxCore` is created per sample, which matches how the runtime
/// resets the core on reconnect.
pub fn measure_core(stream: &[u8], chunk_size: usize, config: &CoreConfig) -> Measurement {
    let run = |stream: &[u8]| {
        let mut core = TransmuxCore::new(config.clone());
        let mut events = Vec::new();
        let mut produced = 0usize;
        for chunk in stream.chunks(chunk_size) {
            core.push_chunk(chunk)
                .expect("benchmark stream must be valid FLV");
            core.drain_events(&mut events);
            produced += events.len();
            events.clear();
        }
        core.flush().expect("benchmark stream must flush cleanly");
        core.drain_events(&mut events);
        produced + events.len()
    };

    for _ in 0..WARMUP_ITERATIONS {
        run(stream);
    }

    let mut best = Duration::MAX;
    let mut events = 0;
    for _ in 0..ITERATIONS {
        let start = Instant::now();
        events = run(stream);
        best = best.min(start.elapsed());
    }

    Measurement {
        duration: best,
        input_bytes: stream.len(),
        events,
    }
}

/// Builds an HTTP-FLV stream with a video sequence header followed by `frames`
/// length-prefixed AVC access units.
///
/// The first frame is a keyframe; later frames use a 33 ms cadence (30 fps).
#[must_use]
pub fn video_flv(frames: usize, frame_bytes: usize) -> Vec<u8> {
    let mut out = flv_header(false, true);

    let mut sequence_header = vec![0x17, 0, 0, 0, 0];
    sequence_header.extend_from_slice(&minimal_avcc());
    out.extend_from_slice(&raw_tag(9, 0, &sequence_header));

    let mut nal = vec![0x41; frame_bytes];
    nal[0] = 0x65;
    for index in 0..frames {
        out.extend_from_slice(&avc_tag((index * 33) as u32, index == 0, &nal));
    }
    out
}

/// Builds an Enhanced FLV HEVC stream using length-prefixed `CodedFramesX`.
///
/// `hvcc` must be a valid `HEVCDecoderConfigurationRecord`.
#[must_use]
pub fn hevc_flv(frames: usize, frame_bytes: usize, hvcc: &[u8]) -> Vec<u8> {
    let mut out = flv_header(false, true);
    out.extend_from_slice(&raw_tag(9, 0, &enhanced_video_tag(0x10, 0, b"hvc1", hvcc)));

    let mut nal = vec![0x41; frame_bytes];
    nal[0] = 0x26;
    nal[1] = 0x01;
    for index in 0..frames {
        let mut body = Vec::with_capacity(4 + nal.len());
        body.extend_from_slice(&(nal.len() as u32).to_be_bytes());
        body.extend_from_slice(&nal);
        let frame_type = if index == 0 { 0x10 } else { 0x20 };
        out.extend_from_slice(&raw_tag(
            9,
            (index * 33) as u32,
            &enhanced_video_tag(frame_type, 3, b"hvc1", &body),
        ));
    }
    out
}

/// Builds an HTTP-FLV stream with interleaved AAC and AVC tags, modelling the
/// many-small-tags shape of an audio-heavy live stream.
#[must_use]
pub fn mixed_flv(pairs: usize, audio_bytes: usize) -> Vec<u8> {
    let mut out = flv_header(true, true);

    let mut audio_config = vec![0xAF, 0];
    audio_config.extend_from_slice(&[0x12, 0x10]);
    out.extend_from_slice(&raw_tag(8, 0, &audio_config));

    let mut video_config = vec![0x17, 0, 0, 0, 0];
    video_config.extend_from_slice(&minimal_avcc());
    out.extend_from_slice(&raw_tag(9, 0, &video_config));

    let mut audio_packet = vec![0xAF, 1];
    audio_packet.extend_from_slice(&vec![0x21; audio_bytes]);
    for index in 0..pairs {
        out.extend_from_slice(&raw_tag(8, (index * 21) as u32, &audio_packet));
        out.extend_from_slice(&avc_tag((index * 33) as u32, index == 0, &[0x41]));
    }
    out
}

/// Builds an Enhanced FLV video tag payload.
#[must_use]
pub fn enhanced_video_tag(
    frame_type: u8,
    packet_type: u8,
    fourcc: &[u8; 4],
    body: &[u8],
) -> Vec<u8> {
    let mut payload = vec![0x80 | frame_type | packet_type];
    payload.extend_from_slice(fourcc);
    payload.extend_from_slice(body);
    payload
}

/// Builds an FLV file header with the given track flags.
#[must_use]
pub fn flv_header(has_audio: bool, has_video: bool) -> Vec<u8> {
    let flags = (u8::from(has_audio) << 2) | u8::from(has_video);
    vec![b'F', b'L', b'V', 1, flags, 0, 0, 0, 9, 0, 0, 0, 0]
}

/// Builds an FLV video tag carrying a length-prefixed AVC access unit.
#[must_use]
pub fn avc_tag(timestamp_ms: u32, is_keyframe: bool, nal: &[u8]) -> Vec<u8> {
    let mut payload = vec![if is_keyframe { 0x17 } else { 0x27 }, 1, 0, 0, 0];
    payload.extend_from_slice(&(nal.len() as u32).to_be_bytes());
    payload.extend_from_slice(nal);
    raw_tag(9, timestamp_ms, &payload)
}

/// Wraps a payload in an FLV tag with a correct `PreviousTagSize`.
#[must_use]
pub fn raw_tag(tag_type: u8, timestamp_ms: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(11 + payload.len() + 4);
    out.push(tag_type);
    out.extend_from_slice(&u24(payload.len() as u32));
    out.extend_from_slice(&u24(timestamp_ms & 0x00FF_FFFF));
    out.push(((timestamp_ms >> 24) & 0xFF) as u8);
    out.extend_from_slice(&[0, 0, 0]);
    out.extend_from_slice(payload);
    out.extend_from_slice(&((11 + payload.len()) as u32).to_be_bytes());
    out
}

/// Valid AVCDecoderConfigurationRecord (Baseline 3.0, 320x240).
#[must_use]
pub fn minimal_avcc() -> Vec<u8> {
    vec![
        1, 0x42, 0xE0, 0x1E, 0xFF, 0xE1, 0x00, 0x04, 0x67, 0x42, 0x00, 0x1E, 0x01, 0x00, 0x02,
        0x68, 0xCE,
    ]
}

/// Valid `HEVCDecoderConfigurationRecord` with VPS, SPS and PPS.
#[must_use]
pub fn minimal_hvcc() -> Vec<u8> {
    vec![
        1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 120, 0xF0, 0, 0xFC, 0xFD, 0xF8, 0xF8, 0, 0, 0x0F, 3,
        0xA0, 0, 1, 0, 3, 0x40, 1, 0x0C, 0xA1, 0, 1, 0, 3, 0x42, 1, 0x80, 0xA2, 0, 1, 0, 3, 0x44,
        1, 0xC0,
    ]
}

fn u24(value: u32) -> [u8; 3] {
    [
        ((value >> 16) & 0xFF) as u8,
        ((value >> 8) & 0xFF) as u8,
        (value & 0xFF) as u8,
    ]
}
