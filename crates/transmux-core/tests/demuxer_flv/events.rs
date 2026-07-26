use rivmux_transmux_core::{
    AudioCodecConfig, AudioCodecKind, ContainerKind, CoreConfig, CoreEvent, EncodedSample,
    TrackConfig, TransmuxCore, VideoCodecConfig, VideoCodecKind,
};

use super::support::{
    audio_sample_tag, audio_sequence_header_tag, build_flv, drain, minimal_avcc, video_sample_tag,
    video_sequence_header_tag,
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
