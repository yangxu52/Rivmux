//! Rust transmux core crate for Rivmux.

pub mod codec;
pub mod core;
pub mod demux;
pub mod error;
pub mod event;
pub mod metadata;
pub mod probe;
pub mod sample;
#[cfg(feature = "wasm")]
pub mod wasm;

pub use crate::core::{CoreConfig, TransmuxCore};
pub use crate::error::{CoreError, CoreErrorCode};
pub use crate::event::{CoreEvent, MediaInfo};
