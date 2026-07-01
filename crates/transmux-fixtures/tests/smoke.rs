#[test]
#[ignore = "reserved until deterministic transmux fixture generation lands"]
fn fixture_generation_is_reserved() {
    assert_eq!(env!("CARGO_PKG_NAME"), "rivmux_transmux_fixtures");
}
