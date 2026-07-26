use crate::error::{CoreError, CoreErrorCode};

pub(super) const FLV_HEADER_MIN_LEN: usize = 9;
pub(super) const PREVIOUS_TAG_SIZE_LEN: usize = 4;
pub(super) const TAG_HEADER_LEN: usize = 11;

pub(super) const TAG_TYPE_AUDIO: u8 = 8;
pub(super) const TAG_TYPE_VIDEO: u8 = 9;
pub(super) const TAG_TYPE_SCRIPT: u8 = 18;

pub(super) const VIDEO_CODEC_ID_AVC: u8 = 7;
pub(super) const SOUND_FORMAT_EX_AUDIO: u8 = 9;
pub(super) const SOUND_FORMAT_AAC: u8 = 10;

pub(super) const VIDEO_EX_HEADER_FLAG: u8 = 0x80;
pub(super) const VIDEO_ENHANCED_FRAME_TYPE_MASK: u8 = 0x70;
pub(super) const VIDEO_PACKET_TYPE_MASK: u8 = 0x0F;

pub(super) const AVC_PACKET_TYPE_SEQUENCE_HEADER: u8 = 0;
pub(super) const AVC_PACKET_TYPE_NALU: u8 = 1;
pub(super) const AVC_PACKET_TYPE_END_OF_SEQUENCE: u8 = 2;

pub(super) const VIDEO_PACKET_TYPE_SEQUENCE_START: u8 = 0;
pub(super) const VIDEO_PACKET_TYPE_CODED_FRAMES: u8 = 1;
pub(super) const VIDEO_PACKET_TYPE_SEQUENCE_END: u8 = 2;
pub(super) const VIDEO_PACKET_TYPE_CODED_FRAMES_X: u8 = 3;
pub(super) const VIDEO_PACKET_TYPE_METADATA: u8 = 4;
pub(super) const VIDEO_PACKET_TYPE_MPEG2TS_SEQUENCE_START: u8 = 5;
pub(super) const VIDEO_PACKET_TYPE_MULTITRACK: u8 = 6;
pub(super) const VIDEO_PACKET_TYPE_MOD_EX: u8 = 7;

pub(super) const AAC_PACKET_TYPE_SEQUENCE_HEADER: u8 = 0;
pub(super) const AAC_PACKET_TYPE_RAW: u8 = 1;

pub(super) const AUDIO_PACKET_TYPE_SEQUENCE_START: u8 = 0;
pub(super) const AUDIO_PACKET_TYPE_CODED_FRAMES: u8 = 1;
pub(super) const AUDIO_PACKET_TYPE_SEQUENCE_END: u8 = 2;
pub(super) const AUDIO_PACKET_TYPE_MULTICHANNEL_CONFIG: u8 = 4;
pub(super) const AUDIO_PACKET_TYPE_MULTITRACK: u8 = 5;
pub(super) const AUDIO_PACKET_TYPE_MOD_EX: u8 = 7;

pub(super) const FLV_TIMESCALE: u32 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FlvParseState {
    Header,
    PreviousTagSize0,
    TagHeader,
    TagBody(FlvTagHeader),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct FlvTagHeader {
    pub(super) tag_type: u8,
    pub(super) data_size: usize,
    pub(super) timestamp_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FlvVideoCodec {
    Avc,
    Hevc,
    Av1,
}

impl FlvVideoCodec {
    pub(super) fn from_fourcc(fourcc: &[u8]) -> Result<Self, CoreError> {
        match fourcc {
            b"avc1" => Ok(Self::Avc),
            b"hvc1" => Ok(Self::Hevc),
            b"av01" => Ok(Self::Av1),
            _ => Err(CoreError::new(
                CoreErrorCode::UnsupportedVideoCodec,
                format!("Unsupported Enhanced FLV video FourCC {fourcc:?}."),
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FlvAudioCodec {
    Aac,
    Opus,
}

impl FlvAudioCodec {
    pub(super) fn from_fourcc(fourcc: &[u8]) -> Result<Self, CoreError> {
        match fourcc {
            b"Opus" => Ok(Self::Opus),
            _ => Err(CoreError::new(
                CoreErrorCode::UnsupportedAudioCodec,
                format!("Unsupported Enhanced FLV audio FourCC {fourcc:?}."),
            )),
        }
    }
}

pub(super) fn read_u24(bytes: &[u8]) -> u32 {
    ((bytes[0] as u32) << 16) | ((bytes[1] as u32) << 8) | bytes[2] as u32
}

pub(super) fn read_i24(bytes: &[u8]) -> i32 {
    let value = read_u24(bytes) as i32;
    if value & 0x0080_0000 != 0 {
        value | !0x00FF_FFFF
    } else {
        value
    }
}

pub(super) fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}
