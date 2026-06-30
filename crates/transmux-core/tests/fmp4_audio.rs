mod support;

use rivmux_transmux_core::{CoreConfig, CoreEvent, TrackKind, TransmuxCore};
use support::{
    audio_sample_tag, audio_sequence_header_tag, build_flv, drain, find_box, minimal_avcc,
    read_box_type, video_sample_tag, video_sequence_header_tag,
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
