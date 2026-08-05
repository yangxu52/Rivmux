use rivmux_transmux_fixtures::{
    H264_AAC_FLV, H264_AAC_FLV_SHA256, HEVC_AAC_FLV, HEVC_AAC_FLV_SHA256,
};
use sha2::{Digest, Sha256};

#[test]
fn h264_aac_fixture_matches_recorded_integrity() {
    assert_eq!(H264_AAC_FLV.len(), 222_370);
    assert_eq!(&H264_AAC_FLV[..3], b"FLV");
    assert_eq!(
        format!("{:x}", Sha256::digest(H264_AAC_FLV)),
        H264_AAC_FLV_SHA256
    );
}

#[test]
fn hevc_aac_fixture_matches_recorded_integrity() {
    assert_eq!(HEVC_AAC_FLV.len(), 53_650);
    assert_eq!(&HEVC_AAC_FLV[..3], b"FLV");
    assert_eq!(
        format!("{:x}", Sha256::digest(HEVC_AAC_FLV)),
        HEVC_AAC_FLV_SHA256
    );
}
