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
mod transmuxer;
#[cfg(feature = "wasm")]
mod wasm;

pub use crate::codec::aac::AudioConfig;
pub use crate::codec::avc::VideoConfig;
pub use crate::error::{CoreError, CoreErrorCode};
pub use crate::event::{
    CoreEvent, CoreWarning, Discontinuity, InitSegment, MediaInfo, MediaSegment, TrackKind,
};
pub use crate::metadata::MetadataEvent;
pub use crate::probe::{AudioCodecKind, ContainerKind, ProbeResult, VideoCodecKind};
pub use crate::sample::{AudioSample, SampleTiming, VideoSample};
pub use crate::transmuxer::{CoreConfig, TransmuxCore};
#[cfg(feature = "wasm")]
pub use crate::wasm::WasmTransmuxCore;
