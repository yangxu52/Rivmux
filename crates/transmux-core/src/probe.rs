#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerKind {
    Flv,
    MpegTs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodecKind {
    Avc,
    Hevc,
    Av1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioCodecKind {
    Aac,
    Mp3,
    Ac3,
    Eac3,
    Opus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
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
