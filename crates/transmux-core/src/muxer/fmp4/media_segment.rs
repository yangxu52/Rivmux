use crate::muxer::fmp4::boxes::{
    concat_box, write_box, write_full_box, write_i32, write_u32, write_u64,
};
use crate::sample::EncodedSample;
use crate::track::TrackClock;

/// Size of an `mdat` box header (`size` + `type`).
const MDAT_HEADER_LEN: usize = 8;

// `moof` size is a compile-time constant: `trun` always carries one sample
// record with fixed flags, `tfdt` always uses version 1 and the track id is
// always a `u32`, so nothing in the box layout depends on the sample payload.
const MOOF_HEADER_LEN: usize = 8;
const MFHD_LEN: usize = 8 + 4 + 4;
const TRAF_HEADER_LEN: usize = 8;
const TFHD_LEN: usize = 8 + 4 + 4;
const TFDT_V1_LEN: usize = 8 + 4 + 8;
const TRUN_VIDEO_LEN: usize = 8 + 4 + 4 + 4 + 4 + 4 + 4 + 4;
const TRUN_AUDIO_LEN: usize = 8 + 4 + 4 + 4 + 4 + 4;
const VIDEO_MOOF_LEN: usize =
    MOOF_HEADER_LEN + MFHD_LEN + TRAF_HEADER_LEN + TFHD_LEN + TFDT_V1_LEN + TRUN_VIDEO_LEN;
const AUDIO_MOOF_LEN: usize =
    MOOF_HEADER_LEN + MFHD_LEN + TRAF_HEADER_LEN + TFHD_LEN + TFDT_V1_LEN + TRUN_AUDIO_LEN;

pub(super) fn build_video_media_segment(
    sequence_number: u32,
    sample: &EncodedSample,
    clock: TrackClock,
) -> Vec<u8> {
    // Build the `moof` once with the correct `data_offset`, then append the
    // `mdat` header and payload directly. Rebuilding the box a second time to
    // measure it would double the box work on every sample.
    let data_offset = (VIDEO_MOOF_LEN + MDAT_HEADER_LEN) as i32;
    let mut out = video_moof(sequence_number, sample, clock, data_offset);
    debug_assert_eq!(out.len(), VIDEO_MOOF_LEN);
    write_u32(&mut out, (MDAT_HEADER_LEN + sample.data().len()) as u32);
    out.extend_from_slice(b"mdat");
    out.extend_from_slice(sample.data());
    out
}

pub(super) fn build_audio_media_segment(
    sequence_number: u32,
    sample: &EncodedSample,
    clock: TrackClock,
) -> Vec<u8> {
    let data_offset = (AUDIO_MOOF_LEN + MDAT_HEADER_LEN) as i32;
    let mut out = audio_moof(sequence_number, sample, clock, data_offset);
    debug_assert_eq!(out.len(), AUDIO_MOOF_LEN);
    write_u32(&mut out, (MDAT_HEADER_LEN + sample.data().len()) as u32);
    out.extend_from_slice(b"mdat");
    out.extend_from_slice(sample.data());
    out
}

fn video_moof(
    sequence_number: u32,
    sample: &EncodedSample,
    clock: TrackClock,
    data_offset: i32,
) -> Vec<u8> {
    write_box(
        b"moof",
        concat_box(vec![
            mfhd(sequence_number),
            video_traf(sample, clock, data_offset),
        ]),
    )
}

fn audio_moof(
    sequence_number: u32,
    sample: &EncodedSample,
    clock: TrackClock,
    data_offset: i32,
) -> Vec<u8> {
    write_box(
        b"moof",
        concat_box(vec![
            mfhd(sequence_number),
            audio_traf(sample, clock, data_offset),
        ]),
    )
}

fn mfhd(sequence_number: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, sequence_number);
    write_full_box(b"mfhd", 0, 0, payload)
}

fn video_traf(sample: &EncodedSample, clock: TrackClock, data_offset: i32) -> Vec<u8> {
    write_box(
        b"traf",
        concat_box(vec![
            tfhd(sample.track_id().get()),
            video_tfdt(sample, clock),
            video_trun(sample, clock, data_offset),
        ]),
    )
}

fn audio_traf(sample: &EncodedSample, clock: TrackClock, data_offset: i32) -> Vec<u8> {
    write_box(
        b"traf",
        concat_box(vec![
            tfhd(sample.track_id().get()),
            audio_tfdt(sample, clock),
            audio_trun(sample, data_offset),
        ]),
    )
}

fn tfhd(track_id: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, track_id);
    write_full_box(b"tfhd", 0, 0x020000, payload)
}

fn video_tfdt(sample: &EncodedSample, clock: TrackClock) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u64(
        &mut payload,
        input_timestamp_to_fmp4(sample.timing().dts, clock),
    );
    write_full_box(b"tfdt", 1, 0, payload)
}

fn audio_tfdt(sample: &EncodedSample, clock: TrackClock) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u64(
        &mut payload,
        input_timestamp_to_fmp4(sample.timing().dts, clock),
    );
    write_full_box(b"tfdt", 1, 0, payload)
}

fn video_trun(sample: &EncodedSample, clock: TrackClock, data_offset: i32) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 1);
    write_i32(&mut payload, data_offset);
    write_u32(&mut payload, sample_duration(sample));
    write_u32(&mut payload, sample.data().len() as u32);
    write_u32(&mut payload, sample_flags(sample));
    write_i32(&mut payload, composition_time_offset(sample, clock));
    write_full_box(b"trun", 1, 0x000F01, payload)
}

fn audio_trun(sample: &EncodedSample, data_offset: i32) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 1);
    write_i32(&mut payload, data_offset);
    write_u32(&mut payload, audio_sample_duration(sample));
    write_u32(&mut payload, sample.data().len() as u32);
    write_full_box(b"trun", 1, 0x000301, payload)
}

pub(super) fn sample_duration(sample: &EncodedSample) -> u32 {
    sample.duration().unwrap_or(1).max(1)
}

pub(super) fn audio_sample_duration(sample: &EncodedSample) -> u32 {
    sample.duration().unwrap_or(1).max(1)
}

pub(super) fn duration_to_milliseconds(duration: u32, timescale: u32) -> i64 {
    let timescale = u64::from(timescale.max(1));
    (((u64::from(duration) * 1_000) + (timescale / 2)) / timescale) as i64
}

pub(super) fn input_timestamp_to_milliseconds(timestamp: i64, timescale: u32) -> i64 {
    scale_signed(timestamp, timescale.max(1), 1_000)
}

pub(super) fn input_duration_to_fmp4(duration: i64, clock: TrackClock) -> u32 {
    scale_unsigned(
        duration.max(1) as u64,
        clock.input_timescale(),
        clock.fmp4_timescale(),
    )
    .clamp(1, u64::from(u32::MAX)) as u32
}

fn sample_flags(sample: &EncodedSample) -> u32 {
    if sample.is_sync() {
        0x0200_0000
    } else {
        0x0101_0000
    }
}

fn composition_time_offset(sample: &EncodedSample, clock: TrackClock) -> i32 {
    scale_signed(
        sample.timing().pts - sample.timing().dts,
        clock.input_timescale(),
        clock.fmp4_timescale(),
    )
    .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn input_timestamp_to_fmp4(timestamp: i64, clock: TrackClock) -> u64 {
    scale_unsigned(
        timestamp.max(0) as u64,
        clock.input_timescale(),
        clock.fmp4_timescale(),
    )
}

fn scale_signed(value: i64, from_timescale: u32, to_timescale: u32) -> i64 {
    let magnitude = scale_unsigned(value.unsigned_abs(), from_timescale, to_timescale);
    if value.is_negative() {
        -(magnitude.min(i64::MAX as u64) as i64)
    } else {
        magnitude.min(i64::MAX as u64) as i64
    }
}

fn scale_unsigned(value: u64, from_timescale: u32, to_timescale: u32) -> u64 {
    ((u128::from(value) * u128::from(to_timescale)) / u128::from(from_timescale))
        .min(u128::from(u64::MAX)) as u64
}
