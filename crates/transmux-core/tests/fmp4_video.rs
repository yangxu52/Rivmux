mod support;

use rivmux_transmux_core::{
    AudioCodecKind, CoreConfig, CoreEvent, TrackKind, TransmuxCore, VideoCodecKind,
};
use support::{
    baseline_320x240_avcc, build_flv, drain, enhanced_video_tag, find_box, minimal_avcc,
    read_box_type, video_sample_tag, video_sequence_header_tag,
};

const HEVC_AAC_FLV: &[u8] = include_bytes!("../../transmux-fixtures/fixtures/hevc-aac.flv");

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

#[test]
fn writes_sps_dimensions_to_media_info_and_avc1_sample_entry() {
    let input = build_flv(vec![
        video_sequence_header_tag(&baseline_320x240_avcc()),
        video_sample_tag(0, true, 0, &[0x00, 0x00, 0x00, 0x01, 0x65]),
        video_sample_tag(33, false, 0, &[0x00, 0x00, 0x00, 0x01, 0x41]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::MediaInfo(info)
                if info.width == Some(320)
                    && info.height == Some(240)
        )
    }));

    let init = events
        .iter()
        .find_map(|event| match event {
            CoreEvent::InitSegment(segment) if segment.track == TrackKind::Video => Some(segment),
            _ => None,
        })
        .expect("expected video init segment");
    assert_eq!(
        read_visual_sample_entry_dimensions(&init.bytes, b"avc1"),
        (320, 240)
    );
}

#[test]
fn writes_av1_sequence_header_dimensions_to_media_info_and_sample_entry() {
    let av1c = [
        0x81, 0x00, 0x0C, 0x00, 0x0A, 0x0A, 0x00, 0x00, 0x00, 0x02, 0xAF, 0xFF, 0x9B, 0x5F, 0x20,
        0x08,
    ];
    let input = build_flv(vec![
        enhanced_video_tag(0, true, 0, b"av01", &av1c),
        enhanced_video_tag(0, true, 1, b"av01", &[0x12, 0x00]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::MediaInfo(info)
                if info.width == Some(64) && info.height == Some(64)
        )
    }));
    let init = events
        .iter()
        .find_map(|event| match event {
            CoreEvent::InitSegment(segment) if segment.track == TrackKind::Video => Some(segment),
            _ => None,
        })
        .expect("expected AV1 init segment");
    assert_eq!(
        read_visual_sample_entry_dimensions(&init.bytes, b"av01"),
        (64, 64)
    );
}

#[test]
fn transmuxes_repository_hevc_aac_fixture_with_stable_muxed_contract() {
    let mut core = TransmuxCore::new(CoreConfig::default());
    for chunk in HEVC_AAC_FLV.chunks(4096) {
        core.push_chunk(chunk).unwrap();
    }
    core.flush().unwrap();
    let events = drain(&mut core);

    let infos: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            CoreEvent::MediaInfo(info) => Some(info),
            _ => None,
        })
        .collect();
    let info = infos
        .iter()
        .find(|info| {
            info.video == Some(VideoCodecKind::Hevc) && info.audio == Some(AudioCodecKind::Aac)
        })
        .expect("expected combined HEVC/AAC media info");
    assert_eq!(info.video_codec.as_deref(), Some("hvc1.1.6.L30.90"));
    assert_eq!(info.audio_codec.as_deref(), Some("mp4a.40.2"));
    assert_eq!(info.width, Some(160));
    assert_eq!(info.height, Some(90));
    assert_eq!(info.audio_sample_rate, Some(44_100));
    assert_eq!(info.audio_channel_count, Some(1));
    let inits: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            CoreEvent::InitSegment(segment) => Some(segment),
            _ => None,
        })
        .collect();
    let init = inits
        .iter()
        .find(|segment| segment.track == TrackKind::Muxed)
        .expect("expected muxed HEVC/AAC init segment");
    assert_eq!(init.codec, "hvc1.1.6.L30.90, mp4a.40.2");
    assert_eq!(init.timescale, 1000);
    assert_eq!(read_box_type(&init.bytes, 0), "ftyp");
    assert!(find_box(&init.bytes, b"hvc1").is_some());
    assert!(find_box(&init.bytes, b"hvcC").is_some());
    assert!(find_box(&init.bytes, b"mp4a").is_some());
    assert!(find_box(&init.bytes, b"esds").is_some());
    let media: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            CoreEvent::MediaSegment(segment) => Some(segment),
            _ => None,
        })
        .collect();
    let video_media: Vec<_> = media
        .iter()
        .filter(|segment| segment.track == TrackKind::Video)
        .collect();
    let audio_media: Vec<_> = media
        .iter()
        .filter(|segment| segment.track == TrackKind::Audio)
        .collect();
    assert!(
        video_media.len() >= 30,
        "expected all 30 HEVC frames, got {}",
        video_media.len()
    );
    assert!(
        audio_media.len() >= 100,
        "expected AAC timeline, got {}",
        audio_media.len()
    );
    assert!(video_media.first().is_some_and(|segment| segment.keyframe));
    assert!(
        video_media
            .iter()
            .filter(|segment| segment.keyframe)
            .count()
            >= 3
    );
    assert!(video_media.iter().all(|segment| {
        segment.dts_end_ms > segment.dts_start_ms
            && find_box(&segment.bytes, b"moof").is_some()
            && find_box(&segment.bytes, b"mdat").is_some()
    }));
    assert!(audio_media.iter().all(|segment| {
        segment.dts_end_ms > segment.dts_start_ms
            && find_box(&segment.bytes, b"moof").is_some()
            && find_box(&segment.bytes, b"mdat").is_some()
    }));
    assert!(
        video_media
            .windows(2)
            .all(|segments| segments[1].dts_start_ms >= segments[0].dts_start_ms)
    );
    assert!(
        audio_media
            .windows(2)
            .all(|segments| segments[1].dts_start_ms >= segments[0].dts_start_ms)
    );
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

fn read_visual_sample_entry_dimensions(bytes: &[u8], name: &[u8; 4]) -> (u16, u16) {
    let offset = find_box(bytes, name).expect("expected visual sample entry");
    (
        u16::from_be_bytes(bytes[offset + 32..offset + 34].try_into().unwrap()),
        u16::from_be_bytes(bytes[offset + 34..offset + 36].try_into().unwrap()),
    )
}
