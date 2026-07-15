mod support;

use rivmux_transmux_core::{CoreConfig, CoreEvent, EncodedSample, TransmuxCore};
use support::{build_flv, drain, minimal_avcc, video_sample_tag, video_sequence_header_tag};

#[test]
fn normalizes_media_segments_to_first_media_dts() {
    let input = build_flv(vec![
        video_sequence_header_tag(&minimal_avcc()),
        video_sample_tag(5_000, true, 10, &[0x00, 0x00, 0x00, 0x01, 0x65]),
        video_sample_tag(5_033, false, 10, &[0x00, 0x00, 0x00, 0x01, 0x41]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::Sample(EncodedSample::Video { timing, .. })
                if timing.dts == 0
                    && timing.pts == 10
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::MediaSegment(segment)
                if segment.dts_start_ms == 0
                    && segment.dts_end_ms == 33
        )
    }));
}

#[test]
fn emits_warning_for_large_forward_timestamp_gap() {
    let input = build_flv(vec![
        video_sequence_header_tag(&minimal_avcc()),
        video_sample_tag(1_000, true, 0, &[0x00, 0x00, 0x00, 0x01, 0x65]),
        video_sample_tag(3_500, true, 0, &[0x00, 0x00, 0x00, 0x01, 0x65]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::Warning(warning)
                if warning.code == "RIVMUX_TIMESTAMP_GAP"
        )
    }));
}

#[test]
fn emits_discontinuity_for_large_timestamp_rollback() {
    let input = build_flv(vec![
        video_sequence_header_tag(&minimal_avcc()),
        video_sample_tag(1_000, true, 0, &[0x00, 0x00, 0x00, 0x01, 0x65]),
        video_sample_tag(900, true, 0, &[0x00, 0x00, 0x00, 0x01, 0x65]),
    ]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::Discontinuity(discontinuity)
                if discontinuity.reason == "timestamp-rollback"
        )
    }));
}
