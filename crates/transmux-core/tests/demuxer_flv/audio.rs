use rivmux_transmux_core::{
    AudioCodecConfig, AudioCodecKind, CoreConfig, CoreErrorCode, CoreEvent, EncodedSample,
    TrackConfig, TransmuxCore,
};

use super::support::{
    audio_sample_tag, build_flv, drain, enhanced_audio_tag, raw_tag, stereo_opus_head,
};

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
}

#[test]
fn rejects_enhanced_flv_opus_multitrack_audio() {
    let input = build_flv(vec![enhanced_audio_tag(0, 5, b"Opus", &[])]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    let error = core.push_chunk(&input).unwrap_err();

    assert_eq!(error.code, CoreErrorCode::UnsupportedAudioCodec);
}
#[test]
fn rejects_aac_raw_sample_before_audio_specific_config() {
    let input = build_flv(vec![audio_sample_tag(0, &[0x21, 0x22])]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    let error = core.push_chunk(&input).unwrap_err();

    assert_eq!(error.code, CoreErrorCode::InvalidCodecConfig);
}
