pub(crate) mod aac;
pub(crate) mod avc;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "MPEG-TS demuxing will construct HEVC normalization inputs in the next container phase."
    )
)]
pub(crate) mod hevc;
pub(crate) mod normalizer;

use crate::codec::aac::AacConfig;
use crate::codec::avc::AvcConfig;
use crate::codec::hevc::HevcConfig;
use crate::probe::{AudioCodecKind, VideoCodecKind};

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub enum VideoCodecConfig {
    Avc(AvcConfig),
    Hevc(HevcConfig),
}

impl VideoCodecConfig {
    #[must_use]
    pub fn kind(&self) -> VideoCodecKind {
        match self {
            Self::Avc(_) => VideoCodecKind::Avc,
            Self::Hevc(_) => VideoCodecKind::Hevc,
        }
    }

    #[must_use]
    pub fn codec_string(&self) -> &str {
        match self {
            Self::Avc(config) => &config.codec_string,
            Self::Hevc(config) => &config.codec_string,
        }
    }

    #[must_use]
    pub fn dimensions(&self) -> (Option<u32>, Option<u32>) {
        match self {
            Self::Avc(config) => (config.width, config.height),
            Self::Hevc(config) => (config.width, config.height),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub enum AudioCodecConfig {
    Aac(AacConfig),
}

impl AudioCodecConfig {
    #[must_use]
    pub fn kind(&self) -> AudioCodecKind {
        match self {
            Self::Aac(_) => AudioCodecKind::Aac,
        }
    }

    #[must_use]
    pub fn codec_string(&self) -> &str {
        match self {
            Self::Aac(config) => &config.codec_string,
        }
    }

    #[must_use]
    pub fn sample_rate(&self) -> u32 {
        match self {
            Self::Aac(config) => config.sample_rate,
        }
    }

    #[must_use]
    pub fn channel_count(&self) -> u8 {
        match self {
            Self::Aac(config) => config.channel_count,
        }
    }
}
