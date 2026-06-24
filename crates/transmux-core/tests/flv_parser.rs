use rivmux_transmux_core::{
    CoreConfig, CoreErrorCode, CoreEvent, TransmuxCore,
    probe::{AudioCodecKind, VideoCodecKind},
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
        matches!(events.first(), Some(CoreEvent::ProbeResult(probe)) if probe.container == rivmux_transmux_core::probe::ContainerKind::Flv)
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
            CoreEvent::VideoConfig(config)
                if config.codec == VideoCodecKind::Avc
                    && config.codec_string == "avc1.42E01E"
                    && config.nal_length_size == 4
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::AudioConfig(config)
                if config.codec == AudioCodecKind::Aac
                    && config.codec_string == "mp4a.40.2"
                    && config.sample_rate == 44_100
                    && config.channel_count == 2
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::VideoSample(sample)
                if sample.is_keyframe
                    && sample.timing.dts_ms == 40
                    && sample.timing.pts_ms == 42
                    && sample.data == [0x00, 0x00, 0x00, 0x01, 0x65]
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            CoreEvent::AudioSample(sample)
                if sample.sample_rate == 44_100
                    && sample.sample_count == 1024
                    && sample.data == [0x21, 0x22, 0x23]
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

fn drain(core: &mut TransmuxCore) -> Vec<CoreEvent> {
    let mut events = Vec::new();
    core.drain_events(&mut events);
    events
}

fn build_flv(tags: Vec<Vec<u8>>) -> Vec<u8> {
    let mut output = flv_header();
    for tag in tags {
        output.extend_from_slice(&tag);
    }
    output
}

fn flv_header() -> Vec<u8> {
    vec![
        b'F',
        b'L',
        b'V',
        1,
        0b0000_0101,
        0,
        0,
        0,
        9, // header
        0,
        0,
        0,
        0, // PreviousTagSize0
    ]
}

fn video_sequence_header_tag(avcc: &[u8]) -> Vec<u8> {
    let mut payload = vec![0x17, 0, 0, 0, 0];
    payload.extend_from_slice(avcc);
    raw_tag(9, 0, &payload)
}

fn video_sample_tag(
    timestamp_ms: u32,
    is_keyframe: bool,
    composition_time_ms: i32,
    nalu: &[u8],
) -> Vec<u8> {
    let frame_and_codec = if is_keyframe { 0x17 } else { 0x27 };
    let mut payload = vec![frame_and_codec, 1];
    payload.extend_from_slice(&i24(composition_time_ms));
    payload.extend_from_slice(nalu);
    raw_tag(9, timestamp_ms, &payload)
}

fn audio_sequence_header_tag(asc: &[u8]) -> Vec<u8> {
    let mut payload = vec![0xAF, 0];
    payload.extend_from_slice(asc);
    raw_tag(8, 0, &payload)
}

fn audio_sample_tag(timestamp_ms: u32, sample: &[u8]) -> Vec<u8> {
    let mut payload = vec![0xAF, 1];
    payload.extend_from_slice(sample);
    raw_tag(8, timestamp_ms, &payload)
}

fn raw_tag(tag_type: u8, timestamp_ms: u32, payload: &[u8]) -> Vec<u8> {
    raw_tag_with_previous_size(tag_type, timestamp_ms, payload, (11 + payload.len()) as u32)
}

fn raw_tag_with_previous_size(
    tag_type: u8,
    timestamp_ms: u32,
    payload: &[u8],
    previous_tag_size: u32,
) -> Vec<u8> {
    let data_size = payload.len() as u32;
    let mut output = Vec::with_capacity(11 + payload.len() + 4);
    output.push(tag_type);
    output.extend_from_slice(&u24(data_size));
    output.extend_from_slice(&u24(timestamp_ms & 0x00FF_FFFF));
    output.push(((timestamp_ms >> 24) & 0xFF) as u8);
    output.extend_from_slice(&[0, 0, 0]);
    output.extend_from_slice(payload);
    output.extend_from_slice(&previous_tag_size.to_be_bytes());
    output
}

fn minimal_avcc() -> Vec<u8> {
    vec![
        1,    // configurationVersion
        0x42, // AVCProfileIndication
        0xE0, // profile_compatibility
        0x1E, // AVCLevelIndication
        0xFF, // lengthSizeMinusOne = 3
        0xE1, // one SPS
        0x00, 0x04, // SPS length
        0x67, 0x42, 0x00, 0x1E, // minimal SPS bytes for parser validation
        0x01, // one PPS
        0x00, 0x02, // PPS length
        0x68, 0xCE,
    ]
}

fn u24(value: u32) -> [u8; 3] {
    [
        ((value >> 16) & 0xFF) as u8,
        ((value >> 8) & 0xFF) as u8,
        (value & 0xFF) as u8,
    ]
}

fn i24(value: i32) -> [u8; 3] {
    u24((value & 0x00FF_FFFF) as u32)
}
