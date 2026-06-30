use crate::codec::aac::AudioConfig;
use crate::codec::avc::VideoConfig;
use crate::error::{CoreError, CoreErrorCode};
use crate::event::{CoreEvent, CoreWarning, InitSegment, MediaSegment, TrackKind};
use crate::muxer::fmp4::init_segment::{
    audio_timescale, build_audio_init_segment, build_muxed_init_segment, build_video_init_segment,
    video_timescale,
};
use crate::muxer::fmp4::media_segment::{
    audio_sample_duration_ms, build_audio_media_segment, build_video_media_segment, sample_duration,
};
use crate::sample::{AudioSample, VideoSample};

#[derive(Debug, Default)]
pub struct Fmp4Muxer {
    video_config: Option<VideoConfig>,
    audio_config: Option<AudioConfig>,
    next_video_sequence_number: u32,
    next_audio_sequence_number: u32,
    video_started: bool,
    init_segment_mode: InitSegmentMode,
}

impl Fmp4Muxer {
    pub fn on_video_config(
        &mut self,
        config: VideoConfig,
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        self.video_config = Some(config);
        self.next_video_sequence_number = 1;
        self.video_started = false;
        self.init_segment_mode = InitSegmentMode::None;
        if self.audio_config.is_some() {
            self.emit_muxed_init_segment(out);
        }
        Ok(())
    }

    pub fn on_audio_config(
        &mut self,
        config: AudioConfig,
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        self.audio_config = Some(config);
        self.next_audio_sequence_number = 1;
        self.init_segment_mode = InitSegmentMode::None;
        if self.video_config.is_some() {
            self.emit_muxed_init_segment(out);
        }
        Ok(())
    }

    pub fn push_video(
        &mut self,
        sample: VideoSample,
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        if self.video_config.is_none() {
            return Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "Cannot mux video sample before video configuration.",
            ));
        }

        if !self.video_started {
            if !sample.is_keyframe {
                out.push(CoreEvent::Warning(CoreWarning::new(
                    "RIVMUX_VIDEO_PRE_KEYFRAME_DROPPED",
                    "Dropping video sample before the first keyframe.",
                )));
                return Ok(());
            }
            self.video_started = true;
        }

        self.ensure_video_init_segment(out);
        let sequence_number = self.next_video_sequence_number;
        self.next_video_sequence_number = self.next_video_sequence_number.saturating_add(1);
        let bytes = build_video_media_segment(sequence_number, &sample);
        let duration_ms = sample_duration(&sample) as i64;
        out.push(CoreEvent::MediaSegment(MediaSegment {
            track: TrackKind::Video,
            dts_start_ms: sample.timing.dts_ms,
            dts_end_ms: sample.timing.dts_ms + duration_ms,
            keyframe: sample.is_keyframe,
            bytes,
        }));
        Ok(())
    }

    pub fn push_audio(
        &mut self,
        sample: AudioSample,
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        if self.audio_config.is_none() {
            return Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "Cannot mux audio sample before audio configuration.",
            ));
        }

        self.ensure_audio_init_segment(out);
        let sequence_number = self.next_audio_sequence_number;
        self.next_audio_sequence_number = self.next_audio_sequence_number.saturating_add(1);
        let bytes = build_audio_media_segment(sequence_number, &sample);
        let duration_ms = audio_sample_duration_ms(&sample);
        out.push(CoreEvent::MediaSegment(MediaSegment {
            track: TrackKind::Audio,
            dts_start_ms: sample.timing.dts_ms,
            dts_end_ms: sample.timing.dts_ms + duration_ms,
            keyframe: true,
            bytes,
        }));
        Ok(())
    }

    fn ensure_video_init_segment(&mut self, out: &mut Vec<CoreEvent>) {
        if self.init_segment_mode != InitSegmentMode::None {
            return;
        }

        if self.audio_config.is_some() {
            self.emit_muxed_init_segment(out);
        } else {
            self.emit_video_init_segment(out);
        }
    }

    fn ensure_audio_init_segment(&mut self, out: &mut Vec<CoreEvent>) {
        if self.init_segment_mode != InitSegmentMode::None {
            return;
        }

        if self.video_config.is_some() {
            self.emit_muxed_init_segment(out);
        } else {
            self.emit_audio_init_segment(out);
        }
    }

    fn emit_video_init_segment(&mut self, out: &mut Vec<CoreEvent>) {
        let Some(config) = &self.video_config else {
            return;
        };

        out.push(CoreEvent::InitSegment(InitSegment {
            track: TrackKind::Video,
            codec: config.codec_string.clone(),
            timescale: video_timescale(),
            bytes: build_video_init_segment(config),
        }));
        self.init_segment_mode = InitSegmentMode::Video;
    }

    fn emit_audio_init_segment(&mut self, out: &mut Vec<CoreEvent>) {
        let Some(config) = &self.audio_config else {
            return;
        };

        out.push(CoreEvent::InitSegment(InitSegment {
            track: TrackKind::Audio,
            codec: config.codec_string.clone(),
            timescale: audio_timescale(config),
            bytes: build_audio_init_segment(config),
        }));
        self.init_segment_mode = InitSegmentMode::Audio;
    }

    fn emit_muxed_init_segment(&mut self, out: &mut Vec<CoreEvent>) {
        let (Some(video_config), Some(audio_config)) = (&self.video_config, &self.audio_config)
        else {
            return;
        };

        out.push(CoreEvent::InitSegment(InitSegment {
            track: TrackKind::Muxed,
            codec: format!(
                "{}, {}",
                video_config.codec_string, audio_config.codec_string
            ),
            timescale: video_timescale(),
            bytes: build_muxed_init_segment(video_config, audio_config),
        }));
        self.init_segment_mode = InitSegmentMode::Muxed;
    }

    pub fn flush(&mut self, _out: &mut Vec<CoreEvent>) -> Result<(), CoreError> {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum InitSegmentMode {
    #[default]
    None,
    Video,
    Audio,
    Muxed,
}
