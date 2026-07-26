use rivmux_transmux_core::{CoreConfig, CoreErrorCode, CoreEvent, TransmuxCore};

use super::support::{drain, flv_header, raw_tag, raw_tag_with_previous_size};

#[test]
fn does_not_emit_tag_before_previous_tag_size_is_validated() {
    let mut input = flv_header();
    let tag = raw_tag(18, 0, &[0x02, 0x00, 0x00]);
    input.extend_from_slice(&tag[..tag.len() - 4]);
    let mut core = TransmuxCore::new(CoreConfig::default());

    core.push_chunk(&input).unwrap();
    let events = drain(&mut core);

    assert!(matches!(events.as_slice(), [CoreEvent::ProbeResult(_)]));

    let error = core.push_chunk(&1_u32.to_be_bytes()).unwrap_err();
    assert_eq!(error.code, CoreErrorCode::InvalidContainerData);
    assert!(matches!(
        drain(&mut core).as_slice(),
        [CoreEvent::FatalError(_)]
    ));
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
