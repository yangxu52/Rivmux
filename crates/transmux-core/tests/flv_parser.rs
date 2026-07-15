mod support;

use rivmux_transmux_core::{
    AudioCodecConfig, AudioCodecKind, ContainerKind, CoreConfig, CoreErrorCode, CoreEvent,
    EncodedSample, TrackConfig, TransmuxCore, VideoCodecConfig, VideoCodecKind,
};
use support::{
    audio_sample_tag, audio_sequence_header_tag, build_flv, drain, enhanced_audio_tag,
    enhanced_video_tag, find_box, flv_header, minimal_avcc, minimal_hvcc, raw_tag,
    raw_tag_with_previous_size, video_sample_tag, video_sequence_header_tag,
};

#[test]
fn parses_flv_header_and_tags_across_arbitrary_chunk_boundaries() {
    let input = build_flv(vec![
        video_sequence_header_tag(&minimal_avcc()),
        audio_sequence_header_tag(&[0x12, 0x10]),
        video_sample_tag(40, true, 2, &[0x00, 0x00, 0x00, 0x01, 0x65]),
        audio_sample_tag(40, &[0x21, 0x22, 0x23]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    for chunk in input.chunks(3) {
        core.push_chunk(chunk).unwrap();
    }

    let events = drain(&mut core);

    assert!(
        matches!(events.first(), Some(CoreEvent::ProbeResult(probe)) if probe.container == ContainerKind::Flv)
    );
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::ProbeResult(probe)
                if probe.video == Some(VideoCodecKind::Avc)
                    && probe.audio == Some(AudioCodecKind::Aac)
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::TrackConfig(TrackConfig::Video(track))
                if matches!(
                    &track.codec,
                    VideoCodecConfig::Avc(config)
                        if config.codec_string == "avc1.42E01E"
                            && config.nal_length_size == 4
                )
                    && track.clock.input_timescale() == 1_000
                    && track.clock.fmp4_timescale() == 1_000
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::TrackConfig(TrackConfig::Audio(track))
                if matches!(
                    &track.codec,
                    AudioCodecConfig::Aac(config)
                        if config.codec_string == "mp4a.40.2"
                            && config.sample_rate == 44_100
                            && config.channel_count == 2
                )
                    && track.clock.input_timescale() == 1_000
                    && track.clock.fmp4_timescale() == 44_100
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::Sample(EncodedSample::Video {
                timing,
                is_sync,
                data,
                ..
            })
                if *is_sync
                    && timing.dts == 0
                    && timing.pts == 2
                    && *data == [0x00, 0x00, 0x00, 0x01, 0x65]
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::Sample(EncodedSample::Audio {
                timing,
                duration,
                data,
                ..
            })
                if *duration == 1024
                    && timing.dts == 0
                    && timing.pts == 0
                    && *data == [0x21, 0x22, 0x23]
        )
    }));
}

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
fn rejects_unsupported_audio_codec_with_structured_error() {
    let input = build_flv(vec![raw_tag(8, 0, &[0x20])]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    let error = core.push_chunk(&input).unwrap_err();

    assert_eq!(error.code, CoreErrorCode::UnsupportedAudioCodec);
}

#[test]
fn parses_enhanced_flv_opus_audio() {
    let input = build_flv(vec![
        enhanced_audio_tag(0, 0, b"Opus", &stereo_opus_head()),
        enhanced_audio_tag(20, 1, b"Opus", &[0xF8, 0xFF, 0xFE]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    for chunk in input.chunks(3) {
        core.push_chunk(chunk).unwrap();
    }
    let events = drain(&mut core);

    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::ProbeResult(probe) if probe.audio == Some(AudioCodecKind::Opus)
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::TrackConfig(TrackConfig::Audio(track))
                if matches!(
                    &track.codec,
                    AudioCodecConfig::Opus(config)
                        if config.codec_string == "opus"
                            && config.channel_count == 2
                            && config.pre_skip == 312
                )
                    && track.clock.input_timescale() == 1_000
                    && track.clock.fmp4_timescale() == 48_000
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::Sample(EncodedSample::Audio {
                timing,
                duration,
                data,
                ..
            }) if timing.dts == 0 && timing.pts == 0 && *duration == 960 && *data == [0xF8, 0xFF, 0xFE]
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::InitSegment(segment)
                if segment.codec == "opus"
                    && segment.timescale == 48_000
                    && find_box(&segment.bytes, b"Opus").is_some()
                    && find_box(&segment.bytes, b"dOps").is_some()
        )
    }));
}

#[test]
fn rejects_enhanced_flv_opus_multitrack_audio() {
    let input = build_flv(vec![enhanced_audio_tag(0, 5, b"Opus", &[])]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    let error = core.push_chunk(&input).unwrap_err();

    assert_eq!(error.code, CoreErrorCode::UnsupportedAudioCodec);
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
    let input = build_flv(vec![
        enhanced_video_tag(100, true, 0, b"av01", &[0x81, 0x08, 0, 0]),
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
                    VideoCodecConfig::Av1(config) if config.codec_string == "av01.0.08M.08"
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
                if segment.codec == "av01.0.08M.08"
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

fn stereo_opus_head() -> [u8; 19] {
    [
        b'O', b'p', b'u', b's', b'H', b'e', b'a', b'd', 1, 2, 0x38, 0x01, 0x80, 0xBB, 0, 0, 0, 0, 0,
    ]
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

#[test]
fn rejects_aac_raw_sample_before_audio_specific_config() {
    let input = build_flv(vec![audio_sample_tag(0, &[0x21, 0x22])]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    let error = core.push_chunk(&input).unwrap_err();

    assert_eq!(error.code, CoreErrorCode::InvalidCodecConfig);
}

#[test]
fn rejects_previous_tag_size_mismatch() {
    let mut input = flv_header();
    input.extend_from_slice(&raw_tag_with_previous_size(18, 0, &[0x02, 0x00, 0x00], 1));
    let mut core = TransmuxCore::new(CoreConfig::default());

    let error = core.push_chunk(&input).unwrap_err();

    assert_eq!(error.code, CoreErrorCode::InvalidContainerData);
}

#[test]
fn flush_rejects_partial_tag() {
    let mut input = flv_header();
    input.extend_from_slice(&[9, 0, 0, 5]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let error = core.flush().unwrap_err();

    assert_eq!(error.code, CoreErrorCode::InvalidContainerData);
}
