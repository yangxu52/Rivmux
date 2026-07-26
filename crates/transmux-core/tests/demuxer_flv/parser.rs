use rivmux_transmux_core::{CoreConfig, CoreErrorCode, TransmuxCore};

use super::support::{flv_header, raw_tag_with_previous_size};

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
