#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub enum ContainerKind {
    Flv,
    MpegTs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub enum VideoCodecKind {
    Avc,
    Hevc,
    Av1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub enum AudioCodecKind {
    Aac,
    Mp3,
    Ac3,
    Eac3,
    Opus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ProbeResult {
    pub container: ContainerKind,
    pub video: Option<VideoCodecKind>,
    pub audio: Option<AudioCodecKind>,
}

impl ProbeResult {
    #[must_use]
    pub fn flv() -> Self {
        Self {
            container: ContainerKind::Flv,
            video: None,
            audio: None,
        }
    }
}
