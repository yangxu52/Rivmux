use rivmux_transmux_core::{
    CoreConfig, CoreErrorCode, CoreEvent, EncodedSample, TrackConfig, TransmuxCore,
    VideoCodecConfig,
};

use super::support::{
    build_flv, drain, enhanced_video_tag, find_box, minimal_avcc, minimal_hvcc, raw_tag,
    video_sample_tag, video_sequence_header_tag,
};

#[test]
fn rejects_unsupported_video_codec_with_structured_error() {
    let input = build_flv(vec![raw_tag(9, 0, &[0x22])]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    let error = core.push_chunk(&input).unwrap_err();
    let events = drain(&mut core);

    assert_eq!(error.code, CoreErrorCode::UnsupportedVideoCodec);
    assert!(matches!(
        events.last(),
        Some(CoreEvent::FatalError(error)) if error.code == CoreErrorCode::UnsupportedVideoCodec
    ));
}
#[test]
fn parses_enhanced_flv_hevc_with_composition_time() {
    let mut coded_frame = vec![0, 0, 2];
    coded_frame.extend_from_slice(&[0, 0, 0, 3, 0x26, 0x01, 0x80]);
    let input = build_flv(vec![
        enhanced_video_tag(100, true, 0, b"hvc1", &minimal_hvcc()),
        enhanced_video_tag(100, true, 1, b"hvc1", &coded_frame),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::TrackConfig(TrackConfig::Video(track))
                if matches!(
                    &track.codec,
                    VideoCodecConfig::Hevc(config) if config.codec_string == "hvc1.1.0.L120"
                )
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::Sample(EncodedSample::Video {
                timing,
                is_sync: true,
                data,
                ..
            }) if timing.dts == 0
                && timing.pts == 2
                && *data == [0, 0, 0, 3, 0x26, 0x01, 0x80]
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::InitSegment(segment)
                if segment.codec == "hvc1.1.0.L120"
                    && find_box(&segment.bytes, b"hvc1").is_some()
                    && find_box(&segment.bytes, b"hvcC").is_some()
        )
    }));
}

#[test]
fn skips_enhanced_flv_hevc_metadata_without_interrupting_coded_frames() {
    let mut coded_frame = vec![0, 0, 2];
    coded_frame.extend_from_slice(&[0, 0, 0, 3, 0x26, 0x01, 0x80]);
    let input = build_flv(vec![
        enhanced_video_tag(100, true, 0, b"hvc1", &minimal_hvcc()),
        enhanced_video_tag(110, false, 4, b"hvc1", &[0xDE, 0xAD, 0xBE, 0xEF]),
        enhanced_video_tag(120, true, 1, b"hvc1", &coded_frame),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::Warning(warning)
                if warning.code == "RIVMUX_FLV_ENHANCED_VIDEO_METADATA_SKIPPED"
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::Sample(EncodedSample::Video { timing, data, .. })
                if timing.dts == 0
                    && timing.pts == 2
                    && *data == [0, 0, 0, 3, 0x26, 0x01, 0x80]
        )
    }));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, CoreEvent::FatalError(_)))
    );
}

#[test]
fn parses_enhanced_flv_avc_with_composition_time() {
    let mut coded_frame = vec![0, 0, 2];
    coded_frame.extend_from_slice(&[0, 0, 0, 1, 0x65]);
    let input = build_flv(vec![
        enhanced_video_tag(100, true, 0, b"avc1", &minimal_avcc()),
        enhanced_video_tag(100, true, 1, b"avc1", &coded_frame),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::TrackConfig(TrackConfig::Video(track))
                if matches!(
                    &track.codec,
                    VideoCodecConfig::Avc(config) if config.codec_string == "avc1.42E01E"
                )
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::Sample(EncodedSample::Video { timing, .. })
                if timing.dts == 0 && timing.pts == 2
        )
    }));
}

#[test]
fn parses_enhanced_flv_coded_frames_x_without_composition_time() {
    let input = build_flv(vec![
        enhanced_video_tag(100, true, 0, b"hvc1", &minimal_hvcc()),
        enhanced_video_tag(100, true, 3, b"hvc1", &[0, 0, 0, 3, 0x26, 0x01, 0x80]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::Sample(EncodedSample::Video { timing, .. })
                if timing.dts == 0 && timing.pts == 0
        )
    }));
}

#[test]
fn parses_enhanced_flv_av1_temporal_unit() {
    let av1c_with_config_obus = [
        0x81, 0x00, 0x0C, 0x00, 0x0A, 0x0A, 0x00, 0x00, 0x00, 0x02, 0xAF, 0xFF, 0x9B, 0x5F, 0x20,
        0x08,
    ];
    let input = build_flv(vec![
        enhanced_video_tag(100, true, 0, b"av01", &av1c_with_config_obus),
        enhanced_video_tag(100, true, 1, b"av01", &[0x12, 0]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::TrackConfig(TrackConfig::Video(track))
                if matches!(
                    &track.codec,
                    VideoCodecConfig::Av1(config)
                        if config.codec_string == "av01.0.00M.08"
                            && config.width == Some(64)
                            && config.height == Some(64)
                )
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::Sample(EncodedSample::Video {
                timing,
                is_sync: true,
                data,
                ..
            }) if timing.dts == 0 && timing.pts == 0 && *data == [0x12, 0]
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::InitSegment(segment)
                if segment.codec == "av01.0.00M.08"
                    && find_box(&segment.bytes, b"av01").is_some()
                    && find_box(&segment.bytes, b"av1C").is_some()
        )
    }));
}

#[test]
fn skips_empty_enhanced_flv_av1_sequence_start_before_configuration() {
    let av1c_with_config_obus = [
        0x81, 0x00, 0x0C, 0x00, 0x0A, 0x0A, 0x00, 0x00, 0x00, 0x02, 0xAF, 0xFF, 0x9B, 0x5F, 0x20,
        0x08,
    ];
    let input = build_flv(vec![
        enhanced_video_tag(0, true, 0, b"av01", &[]),
        enhanced_video_tag(0, true, 0, b"av01", &av1c_with_config_obus),
        enhanced_video_tag(0, true, 1, b"av01", &[0x12, 0]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::Warning(warning)
                if warning.code == "RIVMUX_FLV_ENHANCED_AV1_EMPTY_SEQUENCE_START_SKIPPED"
        )
    }));
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, CoreEvent::TrackConfig(TrackConfig::Video(_))))
            .count(),
        1
    );
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::Sample(EncodedSample::Video {
                timing,
                is_sync: true,
                data,
                ..
            }) if timing.dts == 0 && timing.pts == 0 && *data == [0x12, 0]
        )
    }));
}

#[test]
fn rejects_unknown_enhanced_flv_video_fourcc() {
    let input = build_flv(vec![enhanced_video_tag(0, true, 0, b"vp09", &[])]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    let error = core.push_chunk(&input).unwrap_err();

    assert_eq!(error.code, CoreErrorCode::UnsupportedVideoCodec);
}

#[test]
fn ignores_repeated_flv_avc_sequence_headers() {
    let config = minimal_avcc();
    let input = build_flv(vec![
        video_sequence_header_tag(&config),
        video_sequence_header_tag(&config),
        video_sample_tag(0, true, 0, &[0, 0, 0, 1, 0x65]),
        video_sample_tag(33, false, 0, &[0, 0, 0, 1, 0x41]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, CoreEvent::TrackConfig(TrackConfig::Video(_))))
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, CoreEvent::InitSegment(segment) if segment.codec == "avc1.42E01E"))
            .count(),
        1
    );
}

#[test]
fn rejects_changed_flv_avc_sequence_header_before_emitting_a_second_track_config() {
    let mut changed_config = minimal_avcc();
    changed_config[3] = 0x1F;
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&build_flv(vec![video_sequence_header_tag(&minimal_avcc())]))
        .unwrap();
    let initial_events = drain(&mut core);
    assert_eq!(
        initial_events
            .iter()
            .filter(|event| matches!(event, CoreEvent::TrackConfig(TrackConfig::Video(_))))
            .count(),
        1
    );

    let error = core
        .push_chunk(&video_sequence_header_tag(&changed_config))
        .unwrap_err();
    let events = drain(&mut core);

    assert_eq!(error.code, CoreErrorCode::InvalidCodecConfig);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event, CoreEvent::TrackConfig(TrackConfig::Video(_))))
            .count(),
        0
    );
    assert!(matches!(
        events.last(),
        Some(CoreEvent::FatalError(fatal)) if fatal.code == CoreErrorCode::InvalidCodecConfig
    ));
}
#[test]
fn rejects_avc_sample_before_sequence_header() {
    let input = build_flv(vec![video_sample_tag(
        0,
        true,
        0,
        &[0x00, 0x00, 0x00, 0x01, 0x65],
    )]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    let error = core.push_chunk(&input).unwrap_err();

    assert_eq!(error.code, CoreErrorCode::InvalidCodecConfig);
}
