#![allow(
    dead_code,
    reason = "shared integration-test helpers are compiled separately for each test crate"
)]

use rivmux_transmux_core::{CoreEvent, TransmuxCore};

pub fn drain(core: &mut TransmuxCore) -> Vec<CoreEvent> {
    let mut events = Vec::new();
    core.drain_events(&mut events);
    events
}

pub fn build_flv(tags: Vec<Vec<u8>>) -> Vec<u8> {
    let mut output = flv_header();
    for tag in tags {
        output.extend_from_slice(&tag);
    }
    output
}

pub fn flv_header() -> Vec<u8> {
    vec![b'F', b'L', b'V', 1, 0b0000_0101, 0, 0, 0, 9, 0, 0, 0, 0]
}

pub fn video_sequence_header_tag(avcc: &[u8]) -> Vec<u8> {
    let mut payload = vec![0x17, 0, 0, 0, 0];
    payload.extend_from_slice(avcc);
    raw_tag(9, 0, &payload)
}

pub fn video_sample_tag(
    timestamp_ms: u32,
    is_keyframe: bool,
    composition_time_ms: i32,
    nalu: &[u8],
) -> Vec<u8> {
    let frame_and_codec = if is_keyframe { 0x17 } else { 0x27 };
    let mut payload = vec![frame_and_codec, 1];
    payload.extend_from_slice(&i24(composition_time_ms));
    payload.extend_from_slice(nalu);
    raw_tag(9, timestamp_ms, &payload)
}

pub fn audio_sequence_header_tag(asc: &[u8]) -> Vec<u8> {
    let mut payload = vec![0xAF, 0];
    payload.extend_from_slice(asc);
    raw_tag(8, 0, &payload)
}

pub fn audio_sample_tag(timestamp_ms: u32, sample: &[u8]) -> Vec<u8> {
    let mut payload = vec![0xAF, 1];
    payload.extend_from_slice(sample);
    raw_tag(8, timestamp_ms, &payload)
}

pub fn raw_tag(tag_type: u8, timestamp_ms: u32, payload: &[u8]) -> Vec<u8> {
    raw_tag_with_previous_size(tag_type, timestamp_ms, payload, (11 + payload.len()) as u32)
}

pub fn raw_tag_with_previous_size(
    tag_type: u8,
    timestamp_ms: u32,
    payload: &[u8],
    previous_tag_size: u32,
) -> Vec<u8> {
    let data_size = payload.len() as u32;
    let mut output = Vec::with_capacity(11 + payload.len() + 4);
    output.push(tag_type);
    output.extend_from_slice(&u24(data_size));
    output.extend_from_slice(&u24(timestamp_ms & 0x00FF_FFFF));
    output.push(((timestamp_ms >> 24) & 0xFF) as u8);
    output.extend_from_slice(&[0, 0, 0]);
    output.extend_from_slice(payload);
    output.extend_from_slice(&previous_tag_size.to_be_bytes());
    output
}

pub fn minimal_avcc() -> Vec<u8> {
    vec![
        1, 0x42, 0xE0, 0x1E, 0xFF, 0xE1, 0x00, 0x04, 0x67, 0x42, 0x00, 0x1E, 0x01, 0x00, 0x02,
        0x68, 0xCE,
    ]
}

pub fn read_box_type(bytes: &[u8], offset: usize) -> String {
    String::from_utf8(bytes[offset + 4..offset + 8].to_vec()).unwrap()
}

pub fn find_box(bytes: &[u8], name: &[u8; 4]) -> Option<usize> {
    find_box_from(bytes, name, 0)
}

fn find_box_from(bytes: &[u8], name: &[u8; 4], start: usize) -> Option<usize> {
    let mut offset = start;
    while offset + 8 <= bytes.len() {
        let size = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        if size < 8 || offset + size > bytes.len() {
            return None;
        }

        if &bytes[offset + 4..offset + 8] == name {
            return Some(offset);
        }

        if matches!(
            &bytes[offset + 4..offset + 8],
            b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl"
        ) && let Some(child_offset) = find_box(&bytes[offset + 8..offset + size], name)
        {
            return Some(offset + 8 + child_offset);
        }

        if &bytes[offset + 4..offset + 8] == b"stsd"
            && let Some(child_offset) = find_box_from(&bytes[offset + 8..offset + size], name, 8)
        {
            return Some(offset + 8 + child_offset);
        }

        if &bytes[offset + 4..offset + 8] == b"avc1"
            && let Some(child_offset) = find_box_from(&bytes[offset + 8..offset + size], name, 78)
        {
            return Some(offset + 8 + child_offset);
        }

        if &bytes[offset + 4..offset + 8] == b"mp4a"
            && let Some(child_offset) = find_box_from(&bytes[offset + 8..offset + size], name, 28)
        {
            return Some(offset + 8 + child_offset);
        }

        offset += size;
    }

    None
}

fn u24(value: u32) -> [u8; 3] {
    [
        ((value >> 16) & 0xFF) as u8,
        ((value >> 8) & 0xFF) as u8,
        (value & 0xFF) as u8,
    ]
}

fn i24(value: i32) -> [u8; 3] {
    u24((value & 0x00FF_FFFF) as u32)
}
