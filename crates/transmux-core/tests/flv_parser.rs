mod support;

use rivmux_transmux_core::{
    AudioCodecConfig, AudioCodecKind, ContainerKind, CoreConfig, CoreErrorCode, CoreEvent,
    EncodedSample, TrackConfig, TransmuxCore, VideoCodecConfig, VideoCodecKind,
};
use support::{
    audio_sample_tag, audio_sequence_header_tag, build_flv, drain, flv_header, minimal_avcc,
    raw_tag, raw_tag_with_previous_size, video_sample_tag, video_sequence_header_tag,
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
