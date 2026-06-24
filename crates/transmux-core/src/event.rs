use crate::codec::aac::AudioConfig;
use crate::codec::avc::VideoConfig;
use crate::error::CoreError;
use crate::metadata::MetadataEvent;
use crate::probe::{AudioCodecKind, ContainerKind, ProbeResult, VideoCodecKind};
use crate::sample::{AudioSample, VideoSample};

#[derive(Debug, Clone, PartialEq)]
pub enum CoreEvent {
    ProbeResult(ProbeResult),
    MediaInfo(MediaInfo),
    VideoConfig(VideoConfig),
    AudioConfig(AudioConfig),
    VideoSample(VideoSample),
    AudioSample(AudioSample),
    Metadata(MetadataEvent),
    Warning(CoreWarning),
    FatalError(CoreError),
    Discontinuity(Discontinuity),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaInfo {
    pub container: ContainerKind,
    pub video: Option<VideoCodecKind>,
    pub audio: Option<AudioCodecKind>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub audio_sample_rate: Option<u32>,
    pub audio_channel_count: Option<u8>,
}

impl MediaInfo {
    #[must_use]
    pub fn flv() -> Self {
        Self {
            container: ContainerKind::Flv,
            video: None,
            audio: None,
            video_codec: None,
            audio_codec: None,
            width: None,
            height: None,
            audio_sample_rate: None,
            audio_channel_count: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreWarning {
    pub code: String,
    pub message: String,
}

impl CoreWarning {
    #[must_use]
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Discontinuity {
    pub reason: String,
}
