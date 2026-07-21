mod support;

use rivmux_transmux_core::{CoreConfig, CoreEvent, TrackKind, TransmuxCore};
use support::{
    audio_sample_tag, audio_sequence_header_tag, build_flv, drain, enhanced_audio_tag, find_box,
    minimal_avcc, read_box_type, video_sample_tag, video_sequence_header_tag,
};

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

    assert_eq!(media.dts_start_ms, 0);
    assert_eq!(media.dts_end_ms, 23);
    assert!(media.keyframe);
    assert_eq!(read_box_type(&media.bytes, 0), "moof");
    assert!(find_box(&media.bytes, b"mdat").is_some());
    assert!(media.bytes.ends_with(&[0x21, 0x22, 0x23, 0x24]));
}

#[test]
fn emits_opus_init_and_media_segment() {
    let input = build_flv(vec![
        enhanced_audio_tag(0, 0, b"Opus", &stereo_opus_head()),
        enhanced_audio_tag(20, 1, b"Opus", &[0xF8, 0xFF, 0xFE]),
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

    assert_eq!(init.codec, "opus");
    assert_eq!(init.timescale, 48_000);
    assert!(find_box(&init.bytes, b"Opus").is_some());
    let dops_offset = find_box(&init.bytes, b"dOps").expect("expected dOps box");
    assert_eq!(
        &init.bytes[dops_offset + 8..dops_offset + 19],
        [0, 2, 0x01, 0x38, 0, 0, 0xBB, 0x80, 0, 0, 0]
    );
    assert_eq!(media.dts_start_ms, 0);
    assert_eq!(media.dts_end_ms, 20);
    assert_eq!(read_trun_sample_duration(&media.bytes), 960);
    assert!(media.bytes.ends_with(&[0xF8, 0xFF, 0xFE]));
}

#[test]
fn emits_muxed_init_and_separate_media_segments_for_avc_aac_flv() {
    let input = build_flv(vec![
        video_sequence_header_tag(&minimal_avcc()),
        audio_sequence_header_tag(&[0x12, 0x10]),
        video_sample_tag(0, true, 0, &[0x00, 0x00, 0x00, 0x01, 0x65]),
        video_sample_tag(40, false, 0, &[0x00, 0x00, 0x00, 0x01, 0x41]),
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
    assert_eq!(emitted_init_tracks(&events), vec![TrackKind::Muxed]);
    assert_eq!(
        emitted_media_tracks(&events),
        vec![TrackKind::Video, TrackKind::Audio]
    );
    assert!(!events.iter().any(is_muxed_media_segment));
}

#[test]
fn delays_video_initialization_until_late_audio_configuration_arrives() {
    let input = build_flv(vec![
        video_sequence_header_tag(&minimal_avcc()),
        video_sample_tag(0, true, 0, &[0x00, 0x00, 0x00, 0x01, 0x65]),
        video_sample_tag(40, false, 0, &[0x00, 0x00, 0x00, 0x01, 0x41]),
        audio_sequence_header_tag(&[0x12, 0x10]),
        audio_sample_tag(0, &[0x21, 0x22, 0x23, 0x24]),
        video_sample_tag(80, false, 0, &[0x00, 0x00, 0x00, 0x01, 0x41]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    assert_eq!(
        emitted_segment_order(&events),
        vec![
            ("init", TrackKind::Muxed),
            ("media", TrackKind::Video),
            ("media", TrackKind::Audio),
            ("media", TrackKind::Video),
        ]
    );
}

#[test]
fn delays_audio_initialization_until_late_video_configuration_arrives() {
    let input = build_flv(vec![
        audio_sequence_header_tag(&[0x12, 0x10]),
        audio_sample_tag(0, &[0x21, 0x22, 0x23, 0x24]),
        video_sequence_header_tag(&minimal_avcc()),
        video_sample_tag(0, true, 0, &[0x00, 0x00, 0x00, 0x01, 0x65]),
        video_sample_tag(40, false, 0, &[0x00, 0x00, 0x00, 0x01, 0x41]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    assert_eq!(
        emitted_segment_order(&events),
        vec![
            ("init", TrackKind::Muxed),
            ("media", TrackKind::Audio),
            ("media", TrackKind::Video),
        ]
    );
}

fn emitted_init_tracks(events: &[CoreEvent]) -> Vec<TrackKind> {
    events
        .iter()
        .filter_map(|event| match event {
            CoreEvent::InitSegment(segment) => Some(segment.track),
            _ => None,
        })
        .collect()
}

fn emitted_media_tracks(events: &[CoreEvent]) -> Vec<TrackKind> {
    events
        .iter()
        .filter_map(|event| match event {
            CoreEvent::MediaSegment(segment) => Some(segment.track),
            _ => None,
        })
        .collect()
}

fn emitted_segment_order(events: &[CoreEvent]) -> Vec<(&'static str, TrackKind)> {
    events
        .iter()
        .filter_map(|event| match event {
            CoreEvent::InitSegment(segment) => Some(("init", segment.track)),
            CoreEvent::MediaSegment(segment) => Some(("media", segment.track)),
            _ => None,
        })
        .collect()
}

fn is_muxed_media_segment(event: &CoreEvent) -> bool {
    match event {
        CoreEvent::MediaSegment(segment) => segment.track == TrackKind::Muxed,
        _ => false,
    }
}

fn stereo_opus_head() -> [u8; 19] {
    [
        b'O', b'p', b'u', b's', b'H', b'e', b'a', b'd', 1, 2, 0x38, 0x01, 0x80, 0xBB, 0, 0, 0, 0, 0,
    ]
}

fn read_trun_sample_duration(bytes: &[u8]) -> u32 {
    let offset = find_box(bytes, b"trun").expect("expected trun box");
    u32::from_be_bytes(bytes[offset + 20..offset + 24].try_into().unwrap())
}
