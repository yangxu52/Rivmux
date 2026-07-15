use crate::codec::aac::AacNormalizer;
use crate::codec::av1::Av1Normalizer;
use crate::codec::avc::AvcNormalizer;
use crate::codec::hevc::HevcNormalizer;
use crate::codec::normalizer::{
    AudioAccessUnit, AudioFrameNormalizer, AudioNormalizerEvent, AudioSampleData, VideoAccessUnit,
    VideoAccessUnitNormalizer, VideoNormalizerEvent, VideoSampleData,
};
use crate::codec::opus::OpusNormalizer;
use crate::error::{CoreError, CoreErrorCode};
use crate::event::{CoreEvent, CoreWarning, MediaInfo};
use crate::metadata::MetadataEvent;
use crate::probe::ProbeResult;
use crate::sample::SampleTiming;
use crate::track::{AudioTrackConfig, TrackClock, TrackConfig, TrackId, VideoTrackConfig};

const FLV_HEADER_MIN_LEN: usize = 9;
const PREVIOUS_TAG_SIZE_LEN: usize = 4;
const TAG_HEADER_LEN: usize = 11;

const TAG_TYPE_AUDIO: u8 = 8;
const TAG_TYPE_VIDEO: u8 = 9;
const TAG_TYPE_SCRIPT: u8 = 18;

const VIDEO_CODEC_ID_AVC: u8 = 7;
const SOUND_FORMAT_EX_AUDIO: u8 = 9;
const SOUND_FORMAT_AAC: u8 = 10;

const VIDEO_EX_HEADER_FLAG: u8 = 0x80;
const VIDEO_ENHANCED_FRAME_TYPE_MASK: u8 = 0x70;
const VIDEO_PACKET_TYPE_MASK: u8 = 0x0F;

const AVC_PACKET_TYPE_SEQUENCE_HEADER: u8 = 0;
const AVC_PACKET_TYPE_NALU: u8 = 1;
const AVC_PACKET_TYPE_END_OF_SEQUENCE: u8 = 2;

const VIDEO_PACKET_TYPE_SEQUENCE_START: u8 = 0;
const VIDEO_PACKET_TYPE_CODED_FRAMES: u8 = 1;
const VIDEO_PACKET_TYPE_SEQUENCE_END: u8 = 2;
const VIDEO_PACKET_TYPE_CODED_FRAMES_X: u8 = 3;
const VIDEO_PACKET_TYPE_METADATA: u8 = 4;
const VIDEO_PACKET_TYPE_MPEG2TS_SEQUENCE_START: u8 = 5;
const VIDEO_PACKET_TYPE_MULTITRACK: u8 = 6;
const VIDEO_PACKET_TYPE_MOD_EX: u8 = 7;

const AAC_PACKET_TYPE_SEQUENCE_HEADER: u8 = 0;
const AAC_PACKET_TYPE_RAW: u8 = 1;

const AUDIO_PACKET_TYPE_SEQUENCE_START: u8 = 0;
const AUDIO_PACKET_TYPE_CODED_FRAMES: u8 = 1;
const AUDIO_PACKET_TYPE_SEQUENCE_END: u8 = 2;
const AUDIO_PACKET_TYPE_MULTICHANNEL_CONFIG: u8 = 4;
const AUDIO_PACKET_TYPE_MULTITRACK: u8 = 5;
const AUDIO_PACKET_TYPE_MOD_EX: u8 = 7;

const FLV_TIMESCALE: u32 = 1_000;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlvVideoCodec {
    Avc,
    Hevc,
    Av1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlvAudioCodec {
    Aac,
    Opus,
}

impl FlvAudioCodec {
    fn from_fourcc(fourcc: &[u8]) -> Result<Self, CoreError> {
        match fourcc {
            b"Opus" => Ok(Self::Opus),
            _ => Err(CoreError::new(
                CoreErrorCode::UnsupportedAudioCodec,
                format!("Unsupported Enhanced FLV audio FourCC {fourcc:?}."),
            )),
        }
    }
}

impl FlvVideoCodec {
    fn from_fourcc(fourcc: &[u8]) -> Result<Self, CoreError> {
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

#[derive(Debug)]
enum FlvVideoNormalizer {
    Avc(AvcNormalizer),
    Hevc(HevcNormalizer),
    Av1(Av1Normalizer),
}

impl FlvVideoNormalizer {
    fn new(codec: FlvVideoCodec) -> Self {
        match codec {
            FlvVideoCodec::Avc => Self::Avc(AvcNormalizer::default()),
            FlvVideoCodec::Hevc => Self::Hevc(HevcNormalizer::default()),
            FlvVideoCodec::Av1 => Self::Av1(Av1Normalizer::default()),
        }
    }

    fn codec(&self) -> FlvVideoCodec {
        match self {
            Self::Avc(_) => FlvVideoCodec::Avc,
            Self::Hevc(_) => FlvVideoCodec::Hevc,
            Self::Av1(_) => FlvVideoCodec::Av1,
        }
    }

    fn on_configuration(
        &mut self,
        data: &[u8],
        out: &mut Vec<VideoNormalizerEvent>,
    ) -> Result<(), CoreError> {
        match self {
            Self::Avc(normalizer) => normalizer.on_configuration(data, out),
            Self::Hevc(normalizer) => normalizer.on_configuration(data, out),
            Self::Av1(normalizer) => normalizer.on_configuration(data, out),
        }
    }

    fn push_access_unit(
        &mut self,
        unit: VideoAccessUnit<'_>,
        out: &mut Vec<VideoNormalizerEvent>,
    ) -> Result<(), CoreError> {
        match self {
            Self::Avc(normalizer) => normalizer.push_access_unit(unit, out),
            Self::Hevc(normalizer) => normalizer.push_access_unit(unit, out),
            Self::Av1(normalizer) => normalizer.push_access_unit(unit, out),
        }
    }

    fn flush(&mut self, out: &mut Vec<VideoNormalizerEvent>) -> Result<(), CoreError> {
        match self {
            Self::Avc(normalizer) => normalizer.flush(out),
            Self::Hevc(normalizer) => normalizer.flush(out),
            Self::Av1(normalizer) => normalizer.flush(out),
        }
    }
}

#[derive(Debug)]
enum FlvAudioNormalizer {
    Aac(AacNormalizer),
    Opus(OpusNormalizer),
}

impl FlvAudioNormalizer {
    fn new(codec: FlvAudioCodec) -> Self {
        match codec {
            FlvAudioCodec::Aac => Self::Aac(AacNormalizer::default()),
            FlvAudioCodec::Opus => Self::Opus(OpusNormalizer::default()),
        }
    }

    fn codec(&self) -> FlvAudioCodec {
        match self {
            Self::Aac(_) => FlvAudioCodec::Aac,
            Self::Opus(_) => FlvAudioCodec::Opus,
        }
    }

    fn on_configuration(
        &mut self,
        data: &[u8],
        out: &mut Vec<AudioNormalizerEvent>,
    ) -> Result<(), CoreError> {
        match self {
            Self::Aac(normalizer) => normalizer.on_configuration(data, out),
            Self::Opus(normalizer) => normalizer.on_configuration(data, out),
        }
    }

    fn push_access_unit(
        &mut self,
        unit: AudioAccessUnit<'_>,
        out: &mut Vec<AudioNormalizerEvent>,
    ) -> Result<(), CoreError> {
        match self {
            Self::Aac(normalizer) => normalizer.push_access_unit(unit, out),
            Self::Opus(normalizer) => normalizer.push_access_unit(unit, out),
        }
    }

    fn flush(&mut self, out: &mut Vec<AudioNormalizerEvent>) -> Result<(), CoreError> {
        match self {
            Self::Aac(normalizer) => normalizer.flush(out),
            Self::Opus(normalizer) => normalizer.flush(out),
        }
    }
}

#[derive(Debug)]
pub(crate) struct FlvDemuxer {
    max_tag_data_size: usize,
    buffer: Vec<u8>,
    state: FlvParseState,
    media_info: MediaInfo,
    video_normalizer: Option<FlvVideoNormalizer>,
    audio_normalizer: Option<FlvAudioNormalizer>,
}

impl Default for FlvDemuxer {
    fn default() -> Self {
        Self::new(16 * 1024 * 1024)
    }
}

impl FlvDemuxer {
    #[must_use]
    pub(crate) fn new(max_tag_data_size: usize) -> Self {
        Self {
            max_tag_data_size,
            buffer: Vec::new(),
            state: FlvParseState::Header,
            media_info: MediaInfo::flv(),
            video_normalizer: None,
            audio_normalizer: None,
        }
    }

    pub(crate) fn push(&mut self, data: &[u8], out: &mut Vec<CoreEvent>) -> Result<(), CoreError> {
        self.buffer.extend_from_slice(data);
        self.parse_available(out)
    }

    pub(crate) fn flush(&mut self, out: &mut Vec<CoreEvent>) -> Result<(), CoreError> {
        if !self.buffer.is_empty() {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV input ended with a partial structure.",
            ));
        }

        if let Some(normalizer) = &mut self.video_normalizer {
            let mut video_events = Vec::new();
            normalizer.flush(&mut video_events)?;
            self.process_video_normalizer_events(video_events, out)?;
        }
        if let Some(normalizer) = &mut self.audio_normalizer {
            let mut audio_events = Vec::new();
            normalizer.flush(&mut audio_events)?;
            self.process_audio_normalizer_events(audio_events, out)?;
        }
        Ok(())
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

        if payload[0] & VIDEO_EX_HEADER_FLAG != 0 {
            return self.process_enhanced_video_tag(header, payload, out);
        }

        self.process_legacy_video_tag(header, payload, out)
    }

    fn process_legacy_video_tag(
        &mut self,
        header: FlvTagHeader,
        payload: &[u8],
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
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
                self.push_video_configuration(FlvVideoCodec::Avc, &payload[5..], out)
            }
            AVC_PACKET_TYPE_NALU => self.push_video_access_unit(
                FlvVideoCodec::Avc,
                VideoAccessUnit {
                    track_id: TrackId::VIDEO,
                    timing: SampleTiming {
                        dts: dts_ms,
                        pts: pts_ms,
                    },
                    is_sync: frame_type == 1,
                    data: VideoSampleData::LengthPrefixedNalus(&payload[5..]),
                },
                out,
            ),
            AVC_PACKET_TYPE_END_OF_SEQUENCE => Ok(()),
            other => Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                format!("Unsupported AVC packet type {other}."),
            )),
        }
    }

    fn process_enhanced_video_tag(
        &mut self,
        header: FlvTagHeader,
        payload: &[u8],
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        if payload.len() < 5 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "Enhanced FLV video tag is too short for a FourCC.",
            ));
        }

        let packet_type = payload[0] & VIDEO_PACKET_TYPE_MASK;
        let codec = FlvVideoCodec::from_fourcc(&payload[1..5])?;
        let frame_type = (payload[0] & VIDEO_ENHANCED_FRAME_TYPE_MASK) >> 4;
        let dts_ms = header.timestamp_ms;

        match packet_type {
            VIDEO_PACKET_TYPE_SEQUENCE_START => {
                let configuration = &payload[5..];
                if codec == FlvVideoCodec::Av1 && configuration.is_empty() {
                    // FFmpeg may emit an empty AV1 sequence-start tag before the encoder
                    // has produced its av1C extradata. Do not initialize the codec until the
                    // following non-empty configuration arrives.
                    out.push(CoreEvent::Warning(CoreWarning::new(
                        "RIVMUX_FLV_ENHANCED_AV1_EMPTY_SEQUENCE_START_SKIPPED",
                        "Skipping an empty Enhanced FLV AV1 sequence-start tag.",
                    )));
                    Ok(())
                } else {
                    self.push_video_configuration(codec, configuration, out)
                }
            }
            VIDEO_PACKET_TYPE_CODED_FRAMES => {
                let (pts_ms, data) = match codec {
                    FlvVideoCodec::Avc | FlvVideoCodec::Hevc => {
                        if payload.len() < 8 {
                            return Err(CoreError::new(
                                CoreErrorCode::InvalidContainerData,
                                "Enhanced FLV AVC/HEVC coded frame is missing a composition time offset.",
                            ));
                        }
                        (dts_ms + i64::from(read_i24(&payload[5..8])), &payload[8..])
                    }
                    FlvVideoCodec::Av1 => (dts_ms, &payload[5..]),
                };
                self.push_enhanced_video_sample(codec, frame_type, dts_ms, pts_ms, data, out)
            }
            VIDEO_PACKET_TYPE_CODED_FRAMES_X => {
                if codec == FlvVideoCodec::Av1 {
                    return Err(CoreError::new(
                        CoreErrorCode::InvalidCodecConfig,
                        "Enhanced FLV AV1 does not support CodedFramesX.",
                    ));
                }
                self.push_enhanced_video_sample(
                    codec,
                    frame_type,
                    dts_ms,
                    dts_ms,
                    &payload[5..],
                    out,
                )
            }
            VIDEO_PACKET_TYPE_SEQUENCE_END => Ok(()),
            VIDEO_PACKET_TYPE_METADATA => {
                out.push(CoreEvent::Warning(CoreWarning::new(
                    "RIVMUX_FLV_ENHANCED_VIDEO_METADATA_SKIPPED",
                    "Enhanced FLV video metadata is not mapped to fMP4 output.",
                )));
                Ok(())
            }
            VIDEO_PACKET_TYPE_MPEG2TS_SEQUENCE_START => Err(CoreError::new(
                CoreErrorCode::UnsupportedVideoCodec,
                "Enhanced FLV MPEG-2 TS sequence start is not supported.",
            )),
            VIDEO_PACKET_TYPE_MULTITRACK => Err(CoreError::new(
                CoreErrorCode::UnsupportedVideoCodec,
                "Enhanced FLV multitrack video is not supported.",
            )),
            VIDEO_PACKET_TYPE_MOD_EX => Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "Enhanced FLV VideoPacketType.ModEx is not supported.",
            )),
            other => Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                format!("Unsupported Enhanced FLV video packet type {other}."),
            )),
        }
    }

    fn push_enhanced_video_sample(
        &mut self,
        codec: FlvVideoCodec,
        frame_type: u8,
        dts_ms: i64,
        pts_ms: i64,
        data: &[u8],
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        let is_sync = match frame_type {
            1 | 4 => true,
            2 => false,
            other => {
                return Err(CoreError::new(
                    CoreErrorCode::InvalidContainerData,
                    format!("Unsupported Enhanced FLV coded-frame type {other}."),
                ));
            }
        };
        let data = match codec {
            FlvVideoCodec::Avc | FlvVideoCodec::Hevc => VideoSampleData::LengthPrefixedNalus(data),
            FlvVideoCodec::Av1 => VideoSampleData::ObuTemporalUnit(data),
        };
        self.push_video_access_unit(
            codec,
            VideoAccessUnit {
                track_id: TrackId::VIDEO,
                timing: SampleTiming {
                    dts: dts_ms,
                    pts: pts_ms,
                },
                is_sync,
                data,
            },
            out,
        )
    }

    fn push_video_configuration(
        &mut self,
        codec: FlvVideoCodec,
        data: &[u8],
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        let mut codec_events = Vec::new();
        self.video_normalizer_mut(codec)?
            .on_configuration(data, &mut codec_events)?;
        self.process_video_normalizer_events(codec_events, out)
    }

    fn push_video_access_unit(
        &mut self,
        codec: FlvVideoCodec,
        unit: VideoAccessUnit<'_>,
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        let mut codec_events = Vec::new();
        self.video_normalizer_mut(codec)?
            .push_access_unit(unit, &mut codec_events)?;
        self.process_video_normalizer_events(codec_events, out)
    }

    fn video_normalizer_mut(
        &mut self,
        codec: FlvVideoCodec,
    ) -> Result<&mut FlvVideoNormalizer, CoreError> {
        if let Some(normalizer) = &self.video_normalizer
            && normalizer.codec() != codec
        {
            return Err(CoreError::new(
                CoreErrorCode::UnsupportedVideoCodec,
                "FLV stream changes video codec after video initialization.",
            ));
        }
        Ok(self
            .video_normalizer
            .get_or_insert_with(|| FlvVideoNormalizer::new(codec)))
    }

    fn process_video_normalizer_events(
        &mut self,
        codec_events: Vec<VideoNormalizerEvent>,
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        for event in codec_events {
            match event {
                VideoNormalizerEvent::Configuration(codec) => {
                    self.media_info.video = Some(codec.kind());
                    self.media_info.video_codec = Some(codec.codec_string().to_string());
                    (self.media_info.width, self.media_info.height) = codec.dimensions();
                    let track_config = VideoTrackConfig {
                        id: TrackId::VIDEO,
                        clock: TrackClock::new(FLV_TIMESCALE, FLV_TIMESCALE)?,
                        codec,
                    };
                    out.push(CoreEvent::TrackConfig(TrackConfig::Video(track_config)));
                    out.push(CoreEvent::ProbeResult(self.probe_result()));
                    out.push(CoreEvent::MediaInfo(self.media_info.clone()));
                }
                VideoNormalizerEvent::Sample(sample) => out.push(CoreEvent::Sample(sample)),
            }
        }
        Ok(())
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

        match payload[0] >> 4 {
            SOUND_FORMAT_AAC => self.process_aac_audio_tag(header, payload, out),
            SOUND_FORMAT_EX_AUDIO => self.process_enhanced_audio_tag(header, payload, out),
            sound_format => Err(CoreError::new(
                CoreErrorCode::UnsupportedAudioCodec,
                format!("Unsupported FLV audio sound format {sound_format}."),
            )),
        }
    }

    fn process_aac_audio_tag(
        &mut self,
        header: FlvTagHeader,
        payload: &[u8],
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        if payload.len() < 2 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV AAC audio tag is too short.",
            ));
        }

        match payload[1] {
            AAC_PACKET_TYPE_SEQUENCE_HEADER => {
                let mut codec_events = Vec::new();
                self.audio_normalizer_mut(FlvAudioCodec::Aac)?
                    .on_configuration(&payload[2..], &mut codec_events)?;
                self.process_audio_normalizer_events(codec_events, out)
            }
            AAC_PACKET_TYPE_RAW => {
                let mut codec_events = Vec::new();
                self.audio_normalizer_mut(FlvAudioCodec::Aac)?
                    .push_access_unit(
                        AudioAccessUnit {
                            track_id: TrackId::AUDIO,
                            timing: SampleTiming {
                                dts: header.timestamp_ms,
                                pts: header.timestamp_ms,
                            },
                            input_timescale: FLV_TIMESCALE,
                            data: AudioSampleData::RawAac(&payload[2..]),
                        },
                        &mut codec_events,
                    )?;
                self.process_audio_normalizer_events(codec_events, out)
            }
            other => Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                format!("Unsupported AAC packet type {other}."),
            )),
        }
    }

    fn process_enhanced_audio_tag(
        &mut self,
        header: FlvTagHeader,
        payload: &[u8],
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        if payload.len() < 5 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "Enhanced FLV audio tag is too short for a FourCC.",
            ));
        }

        let packet_type = payload[0] & 0b0000_1111;
        let codec = FlvAudioCodec::from_fourcc(&payload[1..5])?;
        match packet_type {
            AUDIO_PACKET_TYPE_SEQUENCE_START => {
                let mut codec_events = Vec::new();
                self.audio_normalizer_mut(codec)?
                    .on_configuration(&payload[5..], &mut codec_events)?;
                self.process_audio_normalizer_events(codec_events, out)
            }
            AUDIO_PACKET_TYPE_CODED_FRAMES => {
                let mut codec_events = Vec::new();
                self.audio_normalizer_mut(codec)?.push_access_unit(
                    AudioAccessUnit {
                        track_id: TrackId::AUDIO,
                        timing: SampleTiming {
                            dts: header.timestamp_ms,
                            pts: header.timestamp_ms,
                        },
                        input_timescale: FLV_TIMESCALE,
                        data: AudioSampleData::RawOpus(&payload[5..]),
                    },
                    &mut codec_events,
                )?;
                self.process_audio_normalizer_events(codec_events, out)
            }
            AUDIO_PACKET_TYPE_SEQUENCE_END => Ok(()),
            AUDIO_PACKET_TYPE_MULTICHANNEL_CONFIG => Err(CoreError::new(
                CoreErrorCode::UnsupportedAudioCodec,
                "Enhanced FLV Opus multichannel configuration is not supported.",
            )),
            AUDIO_PACKET_TYPE_MULTITRACK => Err(CoreError::new(
                CoreErrorCode::UnsupportedAudioCodec,
                "Enhanced FLV Opus multitrack audio is not supported.",
            )),
            AUDIO_PACKET_TYPE_MOD_EX => Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "Enhanced FLV AudioPacketType.ModEx is not supported.",
            )),
            other => Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                format!("Unsupported Enhanced FLV audio packet type {other}."),
            )),
        }
    }

    fn audio_normalizer_mut(
        &mut self,
        codec: FlvAudioCodec,
    ) -> Result<&mut FlvAudioNormalizer, CoreError> {
        if let Some(normalizer) = &self.audio_normalizer
            && normalizer.codec() != codec
        {
            return Err(CoreError::new(
                CoreErrorCode::UnsupportedAudioCodec,
                "FLV stream changes audio codec after audio initialization.",
            ));
        }
        Ok(self
            .audio_normalizer
            .get_or_insert_with(|| FlvAudioNormalizer::new(codec)))
    }

    fn process_audio_normalizer_events(
        &mut self,
        codec_events: Vec<AudioNormalizerEvent>,
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        for event in codec_events {
            match event {
                AudioNormalizerEvent::Configuration(codec) => {
                    self.media_info.audio = Some(codec.kind());
                    self.media_info.audio_codec = Some(codec.codec_string().to_string());
                    self.media_info.audio_sample_rate = Some(codec.sample_rate());
                    self.media_info.audio_channel_count = Some(codec.channel_count());
                    let track_config = AudioTrackConfig {
                        id: TrackId::AUDIO,
                        clock: TrackClock::new(FLV_TIMESCALE, codec.sample_rate())?,
                        codec,
                    };
                    out.push(CoreEvent::TrackConfig(TrackConfig::Audio(track_config)));
                    out.push(CoreEvent::ProbeResult(self.probe_result()));
                    out.push(CoreEvent::MediaInfo(self.media_info.clone()));
                }
                AudioNormalizerEvent::Sample(sample) => out.push(CoreEvent::Sample(sample)),
            }
        }
        Ok(())
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
