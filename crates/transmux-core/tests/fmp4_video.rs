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
        video_sample_tag(1_033, false, 2, &[0x00, 0x00, 0x00, 0x01, 0x41]),
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
    assert_eq!(media.dts_end_ms, 33);
    assert!(media.keyframe);
    assert_eq!(read_box_type(&media.bytes, 0), "moof");
    assert!(find_box(&media.bytes, b"mdat").is_some());
    assert!(media.bytes.ends_with(&[0x00, 0x00, 0x00, 0x01, 0x65]));
    assert_eq!(read_trun_sample_duration(&media.bytes), 33);
}

#[test]
fn drops_video_samples_before_first_keyframe() {
    let input = build_flv(vec![
        video_sequence_header_tag(&minimal_avcc()),
        video_sample_tag(0, false, 0, &[0x00, 0x00, 0x00, 0x01, 0x41]),
        video_sample_tag(40, true, 0, &[0x00, 0x00, 0x00, 0x01, 0x65]),
        video_sample_tag(80, false, 0, &[0x00, 0x00, 0x00, 0x01, 0x41]),
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

#[test]
fn infers_video_sample_duration_from_adjacent_dts_for_30fps_samples() {
    let input = build_flv(vec![
        video_sequence_header_tag(&minimal_avcc()),
        video_sample_tag(0, true, 0, &[0x00, 0x00, 0x00, 0x01, 0x65]),
        video_sample_tag(33, false, 0, &[0x00, 0x00, 0x00, 0x01, 0x41]),
        video_sample_tag(67, false, 0, &[0x00, 0x00, 0x00, 0x01, 0x41]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let mut events = drain(&mut core);
    core.flush().unwrap();
    events.extend(drain(&mut core));

    let media = video_media_segments(&events);
    assert_eq!(
        media
            .iter()
            .map(|segment| (segment.dts_start_ms, segment.dts_end_ms))
            .collect::<Vec<_>>(),
        vec![(0, 33), (33, 67), (67, 101)]
    );
    assert_eq!(
        media
            .iter()
            .map(|segment| read_trun_sample_duration(&segment.bytes))
            .collect::<Vec<_>>(),
        vec![33, 34, 34]
    );
}

#[test]
fn uses_non_40ms_video_dts_delta_for_sample_duration() {
    let input = build_flv(vec![
        video_sequence_header_tag(&minimal_avcc()),
        video_sample_tag(0, true, 0, &[0x00, 0x00, 0x00, 0x01, 0x65]),
        video_sample_tag(50, false, 0, &[0x00, 0x00, 0x00, 0x01, 0x41]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);
    let media = video_media_segments(&events);

    assert_eq!(media[0].dts_end_ms, 50);
    assert_eq!(read_trun_sample_duration(&media[0].bytes), 50);
}

fn video_media_segments(events: &[CoreEvent]) -> Vec<&rivmux_transmux_core::MediaSegment> {
    events
        .iter()
        .filter_map(|event| match event {
            CoreEvent::MediaSegment(segment) if segment.track == TrackKind::Video => Some(segment),
            _ => None,
        })
        .collect()
}

fn read_trun_sample_duration(bytes: &[u8]) -> u32 {
    let offset = find_box(bytes, b"trun").expect("expected trun box");
    u32::from_be_bytes(bytes[offset + 20..offset + 24].try_into().unwrap())
}
