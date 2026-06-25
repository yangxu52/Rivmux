use rivmux_transmux_core::{CoreConfig, CoreEvent, TransmuxCore, event::TrackKind};

#[test]
fn emits_aac_init_and_media_segment() {
    let input = build_flv(vec![
        audio_sequence_header_tag(&[0x12, 0x10]),
        audio_sample_tag(20, &[0x21, 0x22, 0x23, 0x24]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    let init = events
        .iter()
        .find_map(|event| match event {
            CoreEvent::InitSegment(segment) if segment.track == TrackKind::Audio => Some(segment),
            _ => None,
        })
        .expect("expected audio init segment");
    let media = events
        .iter()
        .find_map(|event| match event {
            CoreEvent::MediaSegment(segment) if segment.track == TrackKind::Audio => Some(segment),
            _ => None,
        })
        .expect("expected audio media segment");

    assert_eq!(init.codec, "mp4a.40.2");
    assert_eq!(init.timescale, 44_100);
    assert_eq!(read_box_type(&init.bytes, 0), "ftyp");
    assert!(find_box(&init.bytes, b"moov").is_some());
    assert!(find_box(&init.bytes, b"mp4a").is_some());
    assert!(find_box(&init.bytes, b"esds").is_some());

    assert_eq!(media.dts_start_ms, 20);
    assert_eq!(media.dts_end_ms, 43);
    assert!(media.keyframe);
    assert_eq!(read_box_type(&media.bytes, 0), "moof");
    assert!(find_box(&media.bytes, b"mdat").is_some());
    assert!(media.bytes.ends_with(&[0x21, 0x22, 0x23, 0x24]));
}

#[test]
fn emits_video_and_audio_segments_for_avc_aac_flv() {
    let input = build_flv(vec![
        video_sequence_header_tag(&minimal_avcc()),
        audio_sequence_header_tag(&[0x12, 0x10]),
        video_sample_tag(0, true, 0, &[0x00, 0x00, 0x00, 0x01, 0x65]),
        audio_sample_tag(0, &[0x21, 0x22, 0x23, 0x24]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    let muxed_init = events
        .iter()
        .find_map(|event| match event {
            CoreEvent::InitSegment(segment) if segment.track == TrackKind::Muxed => Some(segment),
            _ => None,
        })
        .expect("expected muxed init segment");

    assert_eq!(muxed_init.codec, "avc1.42E01E, mp4a.40.2");
    assert!(find_box(&muxed_init.bytes, b"avcC").is_some());
    assert!(find_box(&muxed_init.bytes, b"esds").is_some());
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::MediaSegment(segment) if segment.track == TrackKind::Video
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::MediaSegment(segment) if segment.track == TrackKind::Audio
        )
    }));
}

fn drain(core: &mut TransmuxCore) -> Vec<CoreEvent> {
    let mut events = Vec::new();
    core.drain_events(&mut events);
    events
}

fn build_flv(tags: Vec<Vec<u8>>) -> Vec<u8> {
    let mut output = flv_header();
    for tag in tags {
        output.extend_from_slice(&tag);
    }
    output
}

fn flv_header() -> Vec<u8> {
    vec![b'F', b'L', b'V', 1, 0b0000_0101, 0, 0, 0, 9, 0, 0, 0, 0]
}

fn video_sequence_header_tag(avcc: &[u8]) -> Vec<u8> {
    let mut payload = vec![0x17, 0, 0, 0, 0];
    payload.extend_from_slice(avcc);
    raw_tag(9, 0, &payload)
}

fn video_sample_tag(
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

fn audio_sequence_header_tag(asc: &[u8]) -> Vec<u8> {
    let mut payload = vec![0xAF, 0];
    payload.extend_from_slice(asc);
    raw_tag(8, 0, &payload)
}

fn audio_sample_tag(timestamp_ms: u32, sample: &[u8]) -> Vec<u8> {
    let mut payload = vec![0xAF, 1];
    payload.extend_from_slice(sample);
    raw_tag(8, timestamp_ms, &payload)
}

fn raw_tag(tag_type: u8, timestamp_ms: u32, payload: &[u8]) -> Vec<u8> {
    let data_size = payload.len() as u32;
    let previous_tag_size = (11 + payload.len()) as u32;
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

fn minimal_avcc() -> Vec<u8> {
    vec![
        1, 0x42, 0xE0, 0x1E, 0xFF, 0xE1, 0x00, 0x04, 0x67, 0x42, 0x00, 0x1E, 0x01, 0x00, 0x02,
        0x68, 0xCE,
    ]
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

fn read_box_type(bytes: &[u8], offset: usize) -> String {
    String::from_utf8(bytes[offset + 4..offset + 8].to_vec()).unwrap()
}

fn find_box(bytes: &[u8], name: &[u8; 4]) -> Option<usize> {
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
