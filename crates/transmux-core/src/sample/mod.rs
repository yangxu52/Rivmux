use crate::probe::{AudioCodecKind, VideoCodecKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct SampleTiming {
    pub dts_ms: i64,
    pub pts_ms: i64,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct VideoSample {
    pub codec: VideoCodecKind,
    pub timing: SampleTiming,
    pub is_keyframe: bool,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct AudioSample {
    pub codec: AudioCodecKind,
    pub timing: SampleTiming,
    pub sample_rate: u32,
    pub sample_count: u32,
    pub data: Vec<u8>,
}
