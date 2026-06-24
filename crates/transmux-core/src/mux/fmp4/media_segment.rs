use crate::mux::fmp4::boxes::{
    concat_box, write_box, write_full_box, write_i32, write_u32, write_u64,
};
use crate::sample::VideoSample;

const VIDEO_TRACK_ID: u32 = 1;

pub fn build_video_media_segment(sequence_number: u32, sample: &VideoSample) -> Vec<u8> {
    let mut moof_box = moof(sequence_number, sample, 0);
    let data_offset = (moof_box.len() + 8) as i32;
    moof_box = moof(sequence_number, sample, data_offset);

    concat_box(vec![moof_box, mdat(sample)])
}

fn moof(sequence_number: u32, sample: &VideoSample, data_offset: i32) -> Vec<u8> {
    write_box(
        b"moof",
        concat_box(vec![mfhd(sequence_number), traf(sample, data_offset)]),
    )
}

fn mfhd(sequence_number: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, sequence_number);
    write_full_box(b"mfhd", 0, 0, payload)
}

fn traf(sample: &VideoSample, data_offset: i32) -> Vec<u8> {
    write_box(
        b"traf",
        concat_box(vec![tfhd(), tfdt(sample), trun(sample, data_offset)]),
    )
}

fn tfhd() -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, VIDEO_TRACK_ID);
    write_full_box(b"tfhd", 0, 0x020000, payload)
}

fn tfdt(sample: &VideoSample) -> Vec<u8> {
    let mut payload = Vec::new();
    let base_media_decode_time = sample.timing.dts_ms.max(0) as u64;
    write_u64(&mut payload, base_media_decode_time);
    write_full_box(b"tfdt", 1, 0, payload)
}

fn trun(sample: &VideoSample, data_offset: i32) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 1);
    write_i32(&mut payload, data_offset);
    write_u32(&mut payload, sample_duration(sample));
    write_u32(&mut payload, sample.data.len() as u32);
    write_u32(&mut payload, sample_flags(sample));
    write_i32(&mut payload, composition_time_offset(sample));
    write_full_box(b"trun", 1, 0x000F01, payload)
}

fn mdat(sample: &VideoSample) -> Vec<u8> {
    write_box(b"mdat", sample.data.clone())
}

pub fn sample_duration(sample: &VideoSample) -> u32 {
    sample.timing.duration_ms.unwrap_or(40).max(1) as u32
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
