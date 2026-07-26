mod audio;
mod parser;
mod types;
mod video;

use audio::FlvAudioProcessor;
use parser::{FlvParser, FlvParserEvent};
use types::*;
use video::{FlvVideoEvent, FlvVideoProcessor};

use crate::codec::normalizer::{AudioNormalizerEvent, VideoNormalizerEvent};
use crate::error::{CoreError, CoreErrorCode};
use crate::event::{CoreEvent, CoreWarning, MediaInfo};
use crate::metadata::MetadataEvent;
use crate::probe::ProbeResult;
use crate::track::{AudioTrackConfig, TrackClock, TrackConfig, TrackId, VideoTrackConfig};

#[derive(Debug)]
pub(crate) struct FlvDemuxer {
    parser: FlvParser,
    expects_video: bool,
    expects_audio: bool,
    media_info: MediaInfo,
    video: FlvVideoProcessor,
    audio: FlvAudioProcessor,
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
            audio: FlvAudioProcessor::default(),
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
        let mut audio_events = Vec::new();
        self.audio.flush(&mut audio_events)?;
        self.process_audio_events(audio_events, out)?;
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
        let mut audio_events = Vec::new();
        self.audio.process_tag(header, payload, &mut audio_events)?;
        self.process_audio_events(audio_events, out)
    }

    fn process_audio_events(
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
