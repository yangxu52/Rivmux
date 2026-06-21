#[test]
fn crate_name_is_stable() {
    assert_eq!(env!("CARGO_PKG_NAME"), "rivmux_transmux_fixtures");
}
