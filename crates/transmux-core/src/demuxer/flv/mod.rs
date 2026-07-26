mod parser;
mod types;
mod video;

use parser::{FlvParser, FlvParserEvent};
use types::*;
use video::{FlvVideoEvent, FlvVideoProcessor};

use crate::codec::aac::AacNormalizer;
use crate::codec::normalizer::{
    AudioAccessUnit, AudioFrameNormalizer, AudioNormalizerEvent, AudioSampleData,
    VideoNormalizerEvent,
};
use crate::codec::opus::OpusNormalizer;
use crate::error::{CoreError, CoreErrorCode};
use crate::event::{CoreEvent, CoreWarning, MediaInfo};
use crate::metadata::MetadataEvent;
use crate::probe::ProbeResult;
use crate::sample::SampleTiming;
use crate::track::{AudioTrackConfig, TrackClock, TrackConfig, TrackId, VideoTrackConfig};

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
    parser: FlvParser,
    expects_video: bool,
    expects_audio: bool,
    media_info: MediaInfo,
    video: FlvVideoProcessor,
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
            parser: FlvParser::new(max_tag_data_size),
            expects_video: false,
            expects_audio: false,
            media_info: MediaInfo::flv(),
            video: FlvVideoProcessor::default(),
            audio_normalizer: None,
        }
    }

    pub(crate) fn push(&mut self, data: &[u8], out: &mut Vec<CoreEvent>) -> Result<(), CoreError> {
        self.parser.push(data);
        self.parse_available(out)
    }

    pub(crate) fn flush(&mut self, out: &mut Vec<CoreEvent>) -> Result<(), CoreError> {
        if self.parser.has_buffered_data() {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV input ended with a partial structure.",
            ));
        }

        let mut video_events = Vec::new();
        self.video.flush(&mut video_events)?;
        self.process_video_events(video_events, out)?;
        if let Some(normalizer) = &mut self.audio_normalizer {
            let mut audio_events = Vec::new();
            normalizer.flush(&mut audio_events)?;
            self.process_audio_normalizer_events(audio_events, out)?;
        }
        Ok(())
    }

    pub(crate) const fn expects_audio(&self) -> bool {
        self.expects_audio
    }

    pub(crate) const fn expects_video(&self) -> bool {
        self.expects_video
    }

    fn parse_available(&mut self, out: &mut Vec<CoreEvent>) -> Result<(), CoreError> {
        while let Some(event) = self.parser.next_event()? {
            match event {
                FlvParserEvent::Header {
                    expects_audio,
                    expects_video,
                } => {
                    self.expects_audio = expects_audio;
                    self.expects_video = expects_video;
                    out.push(CoreEvent::ProbeResult(ProbeResult::flv()));
                }
                FlvParserEvent::Tag { header, payload } => {
                    self.process_tag(header, &payload, out)?;
                }
            }
        }
        Ok(())
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
        let mut video_events = Vec::new();
        self.video.process_tag(header, payload, &mut video_events)?;
        self.process_video_events(video_events, out)
    }

    fn process_video_events(
        &mut self,
        video_events: Vec<FlvVideoEvent>,
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        for event in video_events {
            match event {
                FlvVideoEvent::Normalizer(VideoNormalizerEvent::Configuration(codec)) => {
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
                FlvVideoEvent::Normalizer(VideoNormalizerEvent::Sample(sample)) => {
                    out.push(CoreEvent::Sample(sample));
                }
                FlvVideoEvent::Warning(warning) => out.push(CoreEvent::Warning(warning)),
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
