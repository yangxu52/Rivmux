# Rivmux Transmux Fixtures

Repository-owned binary fixtures for transmux and browser acceptance tests.

The crate exposes fixture bytes through `include_bytes!` so Rust tests can share
the same asset consumed by the browser test server. Generation provenance and
integrity values live in `fixtures/README.md`.
