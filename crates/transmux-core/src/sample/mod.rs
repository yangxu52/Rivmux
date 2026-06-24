use crate::probe::{AudioCodecKind, VideoCodecKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SampleTiming {
    pub dts_ms: i64,
    pub pts_ms: i64,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoSample {
    pub codec: VideoCodecKind,
    pub timing: SampleTiming,
    pub is_keyframe: bool,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioSample {
    pub codec: AudioCodecKind,
    pub timing: SampleTiming,
    pub sample_rate: u32,
    pub sample_count: u32,
    pub data: Vec<u8>,
}
