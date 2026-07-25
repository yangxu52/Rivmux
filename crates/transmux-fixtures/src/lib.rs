//! Repository-owned media fixtures shared by transmux and browser tests.

/// Continuous, decodable H.264 Baseline and AAC-LC FLV fixture.
pub const H264_AAC_FLV: &[u8] = include_bytes!("../fixtures/h264-aac.flv");

/// SHA-256 recorded by the deterministic generation recipe.
pub const H264_AAC_FLV_SHA256: &str =
    "2231083b1af0354efe4d6481ab49ca99e210446953db9cff6608b8dbde784ce8";
