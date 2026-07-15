//! Rust transmux core crate for Rivmux.

mod codec;
mod demuxer;
mod error;
mod event;
mod metadata;
mod muxer;
mod probe;
mod sample;
mod timeline;
mod track;
mod transmuxer;
#[cfg(feature = "wasm")]
mod wasm;

pub use crate::codec::aac::AacConfig;
pub use crate::codec::av1::Av1Config;
pub use crate::codec::avc::AvcConfig;
pub use crate::codec::hevc::HevcConfig;
pub use crate::codec::opus::OpusConfig;
pub use crate::codec::{AudioCodecConfig, VideoCodecConfig};
pub use crate::error::{CoreError, CoreErrorCode};
pub use crate::event::{
    CoreEvent, CoreWarning, Discontinuity, InitSegment, MediaInfo, MediaSegment, TrackKind,
};
pub use crate::metadata::MetadataEvent;
pub use crate::probe::{AudioCodecKind, ContainerKind, ProbeResult, VideoCodecKind};
pub use crate::sample::{EncodedSample, SampleTiming};
pub use crate::track::{
    AudioTrackConfig, MediaKind, TrackClock, TrackConfig, TrackId, VideoTrackConfig,
};
pub use crate::transmuxer::{CoreConfig, TransmuxCore};
#[cfg(feature = "wasm")]
pub use crate::wasm::WasmTransmuxCore;
