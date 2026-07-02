use crate::muxer::fmp4::boxes::{
    concat_box, write_box, write_full_box, write_i32, write_u32, write_u64,
};
use crate::sample::{AudioSample, VideoSample};

const VIDEO_TRACK_ID: u32 = 1;
const AUDIO_TRACK_ID: u32 = 2;

pub(super) fn build_video_media_segment(sequence_number: u32, sample: &VideoSample) -> Vec<u8> {
    let mut moof_box = video_moof(sequence_number, sample, 0);
    let data_offset = (moof_box.len() + 8) as i32;
    moof_box = video_moof(sequence_number, sample, data_offset);

    concat_box(vec![moof_box, mdat(&sample.data)])
}

pub(super) fn build_audio_media_segment(sequence_number: u32, sample: &AudioSample) -> Vec<u8> {
    let mut moof_box = audio_moof(sequence_number, sample, 0);
    let data_offset = (moof_box.len() + 8) as i32;
    moof_box = audio_moof(sequence_number, sample, data_offset);

    concat_box(vec![moof_box, mdat(&sample.data)])
}

fn video_moof(sequence_number: u32, sample: &VideoSample, data_offset: i32) -> Vec<u8> {
    write_box(
        b"moof",
        concat_box(vec![mfhd(sequence_number), video_traf(sample, data_offset)]),
    )
}

fn audio_moof(sequence_number: u32, sample: &AudioSample, data_offset: i32) -> Vec<u8> {
    write_box(
        b"moof",
        concat_box(vec![mfhd(sequence_number), audio_traf(sample, data_offset)]),
    )
}

fn mfhd(sequence_number: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, sequence_number);
    write_full_box(b"mfhd", 0, 0, payload)
}

fn video_traf(sample: &VideoSample, data_offset: i32) -> Vec<u8> {
    write_box(
        b"traf",
        concat_box(vec![
            tfhd(VIDEO_TRACK_ID),
            video_tfdt(sample),
            video_trun(sample, data_offset),
        ]),
    )
}

fn audio_traf(sample: &AudioSample, data_offset: i32) -> Vec<u8> {
    write_box(
        b"traf",
        concat_box(vec![
            tfhd(AUDIO_TRACK_ID),
            audio_tfdt(sample),
            audio_trun(sample, data_offset),
        ]),
    )
}

fn tfhd(track_id: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, track_id);
    write_full_box(b"tfhd", 0, 0x020000, payload)
}

fn video_tfdt(sample: &VideoSample) -> Vec<u8> {
    let mut payload = Vec::new();
    let base_media_decode_time = sample.timing.dts_ms.max(0) as u64;
    write_u64(&mut payload, base_media_decode_time);
    write_full_box(b"tfdt", 1, 0, payload)
}

fn audio_tfdt(sample: &AudioSample) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u64(&mut payload, audio_base_media_decode_time(sample));
    write_full_box(b"tfdt", 1, 0, payload)
}

fn video_trun(sample: &VideoSample, data_offset: i32) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 1);
    write_i32(&mut payload, data_offset);
    write_u32(&mut payload, sample_duration(sample));
    write_u32(&mut payload, sample.data.len() as u32);
    write_u32(&mut payload, sample_flags(sample));
    write_i32(&mut payload, composition_time_offset(sample));
    write_full_box(b"trun", 1, 0x000F01, payload)
}

fn audio_trun(sample: &AudioSample, data_offset: i32) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 1);
    write_i32(&mut payload, data_offset);
    write_u32(&mut payload, audio_sample_duration(sample));
    write_u32(&mut payload, sample.data.len() as u32);
    write_full_box(b"trun", 1, 0x000301, payload)
}

fn mdat(data: &[u8]) -> Vec<u8> {
    write_box(b"mdat", data.to_vec())
}

pub(super) fn sample_duration(sample: &VideoSample) -> u32 {
    sample.timing.duration_ms.unwrap_or(1).max(1) as u32
}

pub(super) fn audio_sample_duration(sample: &AudioSample) -> u32 {
    sample.sample_count.max(1)
}

pub(super) fn audio_sample_duration_ms(sample: &AudioSample) -> i64 {
    let sample_rate = i64::from(sample.sample_rate.max(1));
    ((i64::from(audio_sample_duration(sample)) * 1000) + (sample_rate / 2)) / sample_rate
}

fn sample_flags(sample: &VideoSample) -> u32 {
    if sample.is_keyframe {
        0x0200_0000
    } else {
        0x0101_0000
    }
}

fn composition_time_offset(sample: &VideoSample) -> i32 {
    (sample.timing.pts_ms - sample.timing.dts_ms).clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

fn audio_base_media_decode_time(sample: &AudioSample) -> u64 {
    let dts_ms = sample.timing.dts_ms.max(0) as u64;
    (dts_ms * u64::from(sample.sample_rate.max(1))) / 1000
}
