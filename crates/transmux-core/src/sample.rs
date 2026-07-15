use crate::track::{MediaKind, TrackId};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct SampleTiming {
    pub dts: i64,
    pub pts: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(tag = "kind", rename_all = "camelCase"))]
pub enum EncodedSample {
    Video {
        track_id: TrackId,
        timing: SampleTiming,
        duration: Option<u32>,
        is_sync: bool,
        data: Vec<u8>,
    },
    Audio {
        track_id: TrackId,
        timing: SampleTiming,
        duration: u32,
        data: Vec<u8>,
    },
}

impl EncodedSample {
    #[must_use]
    pub const fn kind(&self) -> MediaKind {
        match self {
            Self::Video { .. } => MediaKind::Video,
            Self::Audio { .. } => MediaKind::Audio,
        }
    }

    #[must_use]
    pub const fn track_id(&self) -> TrackId {
        match self {
            Self::Video { track_id, .. } | Self::Audio { track_id, .. } => *track_id,
        }
    }

    #[must_use]
    pub const fn timing(&self) -> &SampleTiming {
        match self {
            Self::Video { timing, .. } | Self::Audio { timing, .. } => timing,
        }
    }

    pub(crate) fn timing_mut(&mut self) -> &mut SampleTiming {
        match self {
            Self::Video { timing, .. } | Self::Audio { timing, .. } => timing,
        }
    }

    #[must_use]
    pub const fn duration(&self) -> Option<u32> {
        match self {
            Self::Video { duration, .. } => *duration,
            Self::Audio { duration, .. } => Some(*duration),
        }
    }

    pub(crate) fn set_video_duration(&mut self, duration: u32) {
        if let Self::Video {
            duration: sample_duration,
            ..
        } = self
        {
            *sample_duration = Some(duration);
        }
    }

    #[must_use]
    pub const fn is_sync(&self) -> bool {
        match self {
            Self::Video { is_sync, .. } => *is_sync,
            Self::Audio { .. } => true,
        }
    }

    #[must_use]
    pub fn data(&self) -> &[u8] {
        match self {
            Self::Video { data, .. } | Self::Audio { data, .. } => data,
        }
    }
}
