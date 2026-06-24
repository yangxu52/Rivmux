use crate::codec::aac::{AudioConfig, parse_audio_specific_config};
use crate::codec::avc::{VideoConfig, parse_avc_decoder_configuration_record};
use crate::error::{CoreError, CoreErrorCode};
use crate::event::{CoreEvent, CoreWarning, MediaInfo};
use crate::metadata::MetadataEvent;
use crate::probe::{AudioCodecKind, ProbeResult, VideoCodecKind};
use crate::sample::{AudioSample, SampleTiming, VideoSample};

const FLV_HEADER_MIN_LEN: usize = 9;
const PREVIOUS_TAG_SIZE_LEN: usize = 4;
const TAG_HEADER_LEN: usize = 11;

const TAG_TYPE_AUDIO: u8 = 8;
const TAG_TYPE_VIDEO: u8 = 9;
const TAG_TYPE_SCRIPT: u8 = 18;

const VIDEO_CODEC_ID_AVC: u8 = 7;
const SOUND_FORMAT_AAC: u8 = 10;

const AVC_PACKET_TYPE_SEQUENCE_HEADER: u8 = 0;
const AVC_PACKET_TYPE_NALU: u8 = 1;
const AVC_PACKET_TYPE_END_OF_SEQUENCE: u8 = 2;

const AAC_PACKET_TYPE_SEQUENCE_HEADER: u8 = 0;
const AAC_PACKET_TYPE_RAW: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlvParseState {
    Header,
    PreviousTagSize0,
    TagHeader,
    TagBody(FlvTagHeader),
    PreviousTagSize(FlvTagHeader),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FlvTagHeader {
    tag_type: u8,
    data_size: usize,
    timestamp_ms: i64,
}

#[derive(Debug)]
pub struct FlvDemuxer {
    max_tag_data_size: usize,
    buffer: Vec<u8>,
    state: FlvParseState,
    media_info: MediaInfo,
    video_config: Option<VideoConfig>,
    audio_config: Option<AudioConfig>,
}

impl Default for FlvDemuxer {
    fn default() -> Self {
        Self::new(16 * 1024 * 1024)
    }
}

impl FlvDemuxer {
    #[must_use]
    pub fn new(max_tag_data_size: usize) -> Self {
        Self {
            max_tag_data_size,
            buffer: Vec::new(),
            state: FlvParseState::Header,
            media_info: MediaInfo::flv(),
            video_config: None,
            audio_config: None,
        }
    }

    pub fn push(&mut self, data: &[u8], out: &mut Vec<CoreEvent>) -> Result<(), CoreError> {
        self.buffer.extend_from_slice(data);
        self.parse_available(out)
    }

    pub fn flush(&mut self, _out: &mut Vec<CoreEvent>) -> Result<(), CoreError> {
        if self.buffer.is_empty() {
            return Ok(());
        }

        Err(CoreError::new(
            CoreErrorCode::InvalidContainerData,
            "FLV input ended with a partial structure.",
        ))
    }

    fn parse_available(&mut self, out: &mut Vec<CoreEvent>) -> Result<(), CoreError> {
        loop {
            match self.state {
                FlvParseState::Header => {
                    if !self.parse_header(out)? {
                        return Ok(());
                    }
                }
                FlvParseState::PreviousTagSize0 => {
                    if !self.parse_previous_tag_size0()? {
                        return Ok(());
                    }
                }
                FlvParseState::TagHeader => {
                    if !self.parse_tag_header()? {
                        return Ok(());
                    }
                }
                FlvParseState::TagBody(header) => {
                    if !self.parse_tag_body(header, out)? {
                        return Ok(());
                    }
                }
                FlvParseState::PreviousTagSize(header) => {
                    if !self.parse_previous_tag_size(header)? {
                        return Ok(());
                    }
                }
            }
        }
    }

    fn parse_header(&mut self, out: &mut Vec<CoreEvent>) -> Result<bool, CoreError> {
        if self.buffer.len() < FLV_HEADER_MIN_LEN {
            return Ok(false);
        }

        if &self.buffer[0..3] != b"FLV" {
            return Err(CoreError::new(
                CoreErrorCode::UnsupportedContainer,
                "Input is not an FLV stream.",
            ));
        }

        if self.buffer[3] != 1 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "Unsupported FLV version.",
            ));
        }

        let data_offset = u32::from_be_bytes([
            self.buffer[5],
            self.buffer[6],
            self.buffer[7],
            self.buffer[8],
        ]) as usize;
        if data_offset < FLV_HEADER_MIN_LEN {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV data offset is smaller than the fixed header.",
            ));
        }

        if self.buffer.len() < data_offset {
            return Ok(false);
        }

        self.buffer.drain(0..data_offset);
        self.state = FlvParseState::PreviousTagSize0;
        out.push(CoreEvent::ProbeResult(ProbeResult::flv()));
        Ok(true)
    }

    fn parse_previous_tag_size0(&mut self) -> Result<bool, CoreError> {
        if self.buffer.len() < PREVIOUS_TAG_SIZE_LEN {
            return Ok(false);
        }

        let previous_tag_size = read_u32(&self.buffer[0..4]);
        if previous_tag_size != 0 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV PreviousTagSize0 must be zero.",
            ));
        }

        self.buffer.drain(0..PREVIOUS_TAG_SIZE_LEN);
        self.state = FlvParseState::TagHeader;
        Ok(true)
    }

    fn parse_tag_header(&mut self) -> Result<bool, CoreError> {
        if self.buffer.len() < TAG_HEADER_LEN {
            return Ok(false);
        }

        let data_size = read_u24(&self.buffer[1..4]) as usize;
        if data_size > self.max_tag_data_size {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV tag data size exceeds the configured limit.",
            ));
        }

        let timestamp_lower = read_u24(&self.buffer[4..7]);
        let timestamp_ms = (timestamp_lower | ((self.buffer[7] as u32) << 24)) as i64;
        let stream_id = read_u24(&self.buffer[8..11]);
        if stream_id != 0 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV tag stream id must be zero.",
            ));
        }

        let header = FlvTagHeader {
            tag_type: self.buffer[0],
            data_size,
            timestamp_ms,
        };
        self.buffer.drain(0..TAG_HEADER_LEN);
        self.state = FlvParseState::TagBody(header);
        Ok(true)
    }

    fn parse_tag_body(
        &mut self,
        header: FlvTagHeader,
        out: &mut Vec<CoreEvent>,
    ) -> Result<bool, CoreError> {
        if self.buffer.len() < header.data_size {
            return Ok(false);
        }

        let payload: Vec<u8> = self.buffer.drain(0..header.data_size).collect();
        self.process_tag(header, &payload, out)?;
        self.state = FlvParseState::PreviousTagSize(header);
        Ok(true)
    }

    fn parse_previous_tag_size(&mut self, header: FlvTagHeader) -> Result<bool, CoreError> {
        if self.buffer.len() < PREVIOUS_TAG_SIZE_LEN {
            return Ok(false);
        }

        let actual = read_u32(&self.buffer[0..4]);
        let expected = (TAG_HEADER_LEN + header.data_size) as u32;
        if actual != expected {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV PreviousTagSize does not match the preceding tag.",
            ));
        }

        self.buffer.drain(0..PREVIOUS_TAG_SIZE_LEN);
        self.state = FlvParseState::TagHeader;
        Ok(true)
    }

    fn process_tag(
        &mut self,
        header: FlvTagHeader,
        payload: &[u8],
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        match header.tag_type {
            TAG_TYPE_VIDEO => self.process_video_tag(header, payload, out),
            TAG_TYPE_AUDIO => self.process_audio_tag(header, payload, out),
            TAG_TYPE_SCRIPT => {
                out.push(CoreEvent::Metadata(MetadataEvent::FlvScriptData {
                    timestamp_ms: header.timestamp_ms,
                    bytes: payload.to_vec(),
                }));
                Ok(())
            }
            other => {
                out.push(CoreEvent::Warning(CoreWarning::new(
                    "RIVMUX_FLV_TAG_SKIPPED",
                    format!("Skipping unsupported FLV tag type {other}."),
                )));
                Ok(())
            }
        }
    }

    fn process_video_tag(
        &mut self,
        header: FlvTagHeader,
        payload: &[u8],
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        if payload.is_empty() {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV video tag is missing the codec header byte.",
            ));
        }

        let frame_type = payload[0] >> 4;
        let codec_id = payload[0] & 0b0000_1111;
        if codec_id != VIDEO_CODEC_ID_AVC {
            return Err(CoreError::new(
                CoreErrorCode::UnsupportedVideoCodec,
                format!("Unsupported FLV video codec id {codec_id}."),
            ));
        }

        if payload.len() < 5 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV AVC video tag is too short.",
            ));
        }

        let avc_packet_type = payload[1];
        let composition_time_ms = read_i24(&payload[2..5]) as i64;
        let dts_ms = header.timestamp_ms;
        let pts_ms = dts_ms + composition_time_ms;

        match avc_packet_type {
            AVC_PACKET_TYPE_SEQUENCE_HEADER => {
                let config = parse_avc_decoder_configuration_record(&payload[5..])?;
                self.media_info.video = Some(VideoCodecKind::Avc);
                self.media_info.video_codec = Some(config.codec_string.clone());
                self.media_info.width = config.width;
                self.media_info.height = config.height;
                self.video_config = Some(config.clone());
                out.push(CoreEvent::VideoConfig(config));
                out.push(CoreEvent::ProbeResult(self.probe_result()));
                out.push(CoreEvent::MediaInfo(self.media_info.clone()));
                Ok(())
            }
            AVC_PACKET_TYPE_NALU => {
                if self.video_config.is_none() {
                    return Err(CoreError::new(
                        CoreErrorCode::InvalidCodecConfig,
                        "FLV AVC media sample arrived before AVC sequence header.",
                    ));
                }

                out.push(CoreEvent::VideoSample(VideoSample {
                    codec: VideoCodecKind::Avc,
                    timing: SampleTiming {
                        dts_ms,
                        pts_ms,
                        duration_ms: None,
                    },
                    is_keyframe: frame_type == 1,
                    data: payload[5..].to_vec(),
                }));
                Ok(())
            }
            AVC_PACKET_TYPE_END_OF_SEQUENCE => Ok(()),
            other => Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                format!("Unsupported AVC packet type {other}."),
            )),
        }
    }

    fn process_audio_tag(
        &mut self,
        header: FlvTagHeader,
        payload: &[u8],
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        if payload.is_empty() {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV audio tag is missing the codec header byte.",
            ));
        }

        let sound_format = payload[0] >> 4;
        if sound_format != SOUND_FORMAT_AAC {
            return Err(CoreError::new(
                CoreErrorCode::UnsupportedAudioCodec,
                format!("Unsupported FLV audio sound format {sound_format}."),
            ));
        }

        if payload.len() < 2 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV AAC audio tag is too short.",
            ));
        }

        match payload[1] {
            AAC_PACKET_TYPE_SEQUENCE_HEADER => {
                let config = parse_audio_specific_config(&payload[2..])?;
                self.media_info.audio = Some(AudioCodecKind::Aac);
                self.media_info.audio_codec = Some(config.codec_string.clone());
                self.media_info.audio_sample_rate = Some(config.sample_rate);
                self.media_info.audio_channel_count = Some(config.channel_count);
                self.audio_config = Some(config.clone());
                out.push(CoreEvent::AudioConfig(config));
                out.push(CoreEvent::ProbeResult(self.probe_result()));
                out.push(CoreEvent::MediaInfo(self.media_info.clone()));
                Ok(())
            }
            AAC_PACKET_TYPE_RAW => {
                let config = self.audio_config.as_ref().ok_or_else(|| {
                    CoreError::new(
                        CoreErrorCode::InvalidCodecConfig,
                        "FLV AAC media sample arrived before AudioSpecificConfig.",
                    )
                })?;
                out.push(CoreEvent::AudioSample(AudioSample {
                    codec: AudioCodecKind::Aac,
                    timing: SampleTiming {
                        dts_ms: header.timestamp_ms,
                        pts_ms: header.timestamp_ms,
                        duration_ms: None,
                    },
                    sample_rate: config.sample_rate,
                    sample_count: 1024,
                    data: payload[2..].to_vec(),
                }));
                Ok(())
            }
            other => Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                format!("Unsupported AAC packet type {other}."),
            )),
        }
    }

    fn probe_result(&self) -> ProbeResult {
        ProbeResult {
            container: self.media_info.container,
            video: self.media_info.video,
            audio: self.media_info.audio,
        }
    }
}

fn read_u24(bytes: &[u8]) -> u32 {
    ((bytes[0] as u32) << 16) | ((bytes[1] as u32) << 8) | bytes[2] as u32
}

fn read_i24(bytes: &[u8]) -> i32 {
    let value = read_u24(bytes) as i32;
    if value & 0x0080_0000 != 0 {
        value | !0x00FF_FFFF
    } else {
        value
    }
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}
