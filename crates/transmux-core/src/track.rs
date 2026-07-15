use crate::codec::{AudioCodecConfig, VideoCodecConfig};
use crate::error::{CoreError, CoreErrorCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(transparent))]
pub struct TrackId(u32);

impl TrackId {
    pub const VIDEO: Self = Self(1);
    pub const AUDIO: Self = Self(2);

    #[must_use]
    pub const fn new(value: u32) -> Option<Self> {
        if value == 0 { None } else { Some(Self(value)) }
    }

    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub enum MediaKind {
    Video,
    Audio,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct TrackClock {
    input_timescale: u32,
    fmp4_timescale: u32,
}

impl TrackClock {
    pub fn new(input_timescale: u32, fmp4_timescale: u32) -> Result<Self, CoreError> {
        if input_timescale == 0 || fmp4_timescale == 0 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidTimestamp,
                "Track timescales must be greater than zero.",
            ));
        }

        Ok(Self {
            input_timescale,
            fmp4_timescale,
        })
    }

    #[must_use]
    pub const fn input_timescale(self) -> u32 {
        self.input_timescale
    }

    #[must_use]
    pub const fn fmp4_timescale(self) -> u32 {
        self.fmp4_timescale
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct VideoTrackConfig {
    pub id: TrackId,
    pub clock: TrackClock,
    pub codec: VideoCodecConfig,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct AudioTrackConfig {
    pub id: TrackId,
    pub clock: TrackClock,
    pub codec: AudioCodecConfig,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(
    feature = "serde",
    serde(tag = "kind", content = "config", rename_all = "camelCase")
)]
pub enum TrackConfig {
    Video(VideoTrackConfig),
    Audio(AudioTrackConfig),
}

impl TrackConfig {
    #[must_use]
    pub const fn kind(&self) -> MediaKind {
        match self {
            Self::Video(_) => MediaKind::Video,
            Self::Audio(_) => MediaKind::Audio,
        }
    }

    #[must_use]
    pub const fn id(&self) -> TrackId {
        match self {
            Self::Video(config) => config.id,
            Self::Audio(config) => config.id,
        }
    }
}
