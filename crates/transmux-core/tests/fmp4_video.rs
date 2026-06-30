mod support;

use rivmux_transmux_core::{CoreConfig, CoreEvent, TrackKind, TransmuxCore};
use support::{
    build_flv, drain, find_box, minimal_avcc, read_box_type, video_sample_tag,
    video_sequence_header_tag,
};

#[test]
fn emits_video_init_and_keyframe_media_segment() {
    let input = build_flv(vec![
        video_sequence_header_tag(&minimal_avcc()),
        video_sample_tag(1_000, true, 2, &[0x00, 0x00, 0x00, 0x01, 0x65]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    let init = events
        .iter()
        .find_map(|event| match event {
            CoreEvent::InitSegment(segment) => Some(segment),
            _ => None,
        })
        .expect("expected video init segment");
    let media = events
        .iter()
        .find_map(|event| match event {
            CoreEvent::MediaSegment(segment) => Some(segment),
            _ => None,
        })
        .expect("expected video media segment");

    assert_eq!(init.track, TrackKind::Video);
    assert_eq!(init.codec, "avc1.42E01E");
    assert_eq!(init.timescale, 1000);
    assert_eq!(read_box_type(&init.bytes, 0), "ftyp");
    assert!(find_box(&init.bytes, b"moov").is_some());
    assert!(find_box(&init.bytes, b"avcC").is_some());

    assert_eq!(media.track, TrackKind::Video);
    assert_eq!(media.dts_start_ms, 0);
    assert_eq!(media.dts_end_ms, 40);
    assert!(media.keyframe);
    assert_eq!(read_box_type(&media.bytes, 0), "moof");
    assert!(find_box(&media.bytes, b"mdat").is_some());
    assert!(media.bytes.ends_with(&[0x00, 0x00, 0x00, 0x01, 0x65]));
}

#[test]
fn drops_video_samples_before_first_keyframe() {
    let input = build_flv(vec![
        video_sequence_header_tag(&minimal_avcc()),
        video_sample_tag(0, false, 0, &[0x00, 0x00, 0x00, 0x01, 0x41]),
        video_sample_tag(40, true, 0, &[0x00, 0x00, 0x00, 0x01, 0x65]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);
    let media_segments = events
        .iter()
        .filter(|event| matches!(event, CoreEvent::MediaSegment(_)))
        .count();

    assert_eq!(media_segments, 1);
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::Warning(warning) if warning.code == "RIVMUX_VIDEO_PRE_KEYFRAME_DROPPED"
        )
    }));
}
