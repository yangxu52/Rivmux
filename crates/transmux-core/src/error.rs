use std::error::Error;
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreErrorCode {
    UnsupportedContainer,
    UnsupportedVideoCodec,
    UnsupportedAudioCodec,
    InvalidContainerData,
    InvalidCodecConfig,
    InvalidTimestamp,
    MuxerError,
    InternalError,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreError {
    pub code: CoreErrorCode,
    pub message: String,
}

impl CoreError {
    #[must_use]
    pub fn new(code: CoreErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl Display for CoreError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.message)
    }
}

impl Error for CoreError {}
