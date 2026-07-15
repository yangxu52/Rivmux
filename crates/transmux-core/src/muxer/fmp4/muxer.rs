use crate::error::{CoreError, CoreErrorCode};
use crate::event::{CoreEvent, CoreWarning, InitSegment, MediaSegment, TrackKind};
use crate::muxer::fmp4::init_segment::{
    Fmp4AudioCodec, Fmp4VideoCodec, audio_timescale, build_audio_init_segment,
    build_video_init_segment, video_timescale,
};
use crate::muxer::fmp4::media_segment::{
    audio_sample_duration, build_audio_media_segment, build_video_media_segment,
    duration_to_milliseconds, input_duration_to_fmp4, input_timestamp_to_milliseconds,
};
use crate::sample::EncodedSample;
use crate::track::{AudioTrackConfig, MediaKind, TrackConfig, VideoTrackConfig};

#[derive(Debug, Default)]
pub(crate) struct Fmp4Muxer {
    video_config: Option<VideoTrackConfig>,
    audio_config: Option<AudioTrackConfig>,
    next_video_sequence_number: u32,
    next_audio_sequence_number: u32,
    video_started: bool,
    video_init_emitted: bool,
    audio_init_emitted: bool,
    pending_video_sample: Option<EncodedSample>,
    last_video_sample_duration: Option<u32>,
}

impl Fmp4Muxer {
    pub(crate) fn on_track_config(
        &mut self,
        config: TrackConfig,
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        match config {
            TrackConfig::Video(config) => self.on_video_config(config, out),
            TrackConfig::Audio(config) => self.on_audio_config(config, out),
        }
    }

    pub(crate) fn push_sample(
        &mut self,
        sample: EncodedSample,
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        match sample.kind() {
            MediaKind::Video => self.push_video(sample, out),
            MediaKind::Audio => self.push_audio(sample, out),
        }
    }

    fn on_video_config(
        &mut self,
        config: VideoTrackConfig,
        _out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        if let Some(previous) = &self.video_config {
            if previous == &config {
                return Ok(());
            }
            return Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "Video configuration changes after muxer initialization are not supported.",
            ));
        }
        self.video_config = Some(config);
        self.next_video_sequence_number = 1;
        self.video_started = false;
        self.video_init_emitted = false;
        self.pending_video_sample = None;
        self.last_video_sample_duration = None;
        Ok(())
    }

    fn on_audio_config(
        &mut self,
        config: AudioTrackConfig,
        _out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        if let Some(previous) = &self.audio_config {
            if previous == &config {
                return Ok(());
            }
            return Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "Audio configuration changes after muxer initialization are not supported.",
            ));
        }
        self.audio_config = Some(config);
        self.next_audio_sequence_number = 1;
        self.audio_init_emitted = false;
        Ok(())
    }

    fn push_video(
        &mut self,
        sample: EncodedSample,
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        let video_config = self.video_config.as_ref().ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "Cannot mux video sample before video configuration.",
            )
        })?;
        if sample.track_id() != video_config.id {
            return Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "Video sample track does not match the configured video track.",
            ));
        }
        let clock = video_config.clock;

        if !self.video_started {
            if !sample.is_sync() {
                out.push(CoreEvent::Warning(CoreWarning::new(
                    "RIVMUX_VIDEO_PRE_KEYFRAME_DROPPED",
                    "Dropping video sample before the first keyframe.",
                )));
                return Ok(());
            }
            self.video_started = true;
        }

        self.ensure_video_init_segment(out);
        if let Some(previous) = self.pending_video_sample.take() {
            let duration = infer_video_sample_duration(&previous, &sample, clock);
            self.emit_video_media_segment(previous, duration, clock, out);
        }
        self.pending_video_sample = Some(sample);
        Ok(())
    }

    fn push_audio(
        &mut self,
        sample: EncodedSample,
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        let audio_config = self.audio_config.as_ref().ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "Cannot mux audio sample before audio configuration.",
            )
        })?;
        if sample.track_id() != audio_config.id {
            return Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "Audio sample track does not match the configured audio track.",
            ));
        }
        let clock = audio_config.clock;

        self.ensure_audio_init_segment(out);
        let sequence_number = self.next_audio_sequence_number;
        self.next_audio_sequence_number = self.next_audio_sequence_number.saturating_add(1);
        let bytes = build_audio_media_segment(sequence_number, &sample, clock);
        let duration_ms =
            duration_to_milliseconds(audio_sample_duration(&sample), clock.fmp4_timescale());
        let dts_start_ms =
            input_timestamp_to_milliseconds(sample.timing().dts, clock.input_timescale());
        out.push(CoreEvent::MediaSegment(MediaSegment {
            track: TrackKind::Audio,
            dts_start_ms,
            dts_end_ms: dts_start_ms + duration_ms,
            keyframe: sample.is_sync(),
            bytes,
        }));
        Ok(())
    }

    fn ensure_video_init_segment(&mut self, out: &mut Vec<CoreEvent>) {
        if self.video_init_emitted {
            return;
        }

        self.emit_video_init_segment(out);
    }

    fn ensure_audio_init_segment(&mut self, out: &mut Vec<CoreEvent>) {
        if self.audio_init_emitted {
            return;
        }

        self.emit_audio_init_segment(out);
    }

    fn emit_video_init_segment(&mut self, out: &mut Vec<CoreEvent>) {
        let Some(config) = &self.video_config else {
            return;
        };

        out.push(CoreEvent::InitSegment(InitSegment {
            track: TrackKind::Video,
            codec: Fmp4VideoCodec::codec_string(&config.codec).to_string(),
            timescale: video_timescale(config),
            bytes: build_video_init_segment(config),
        }));
        self.video_init_emitted = true;
    }

    fn emit_audio_init_segment(&mut self, out: &mut Vec<CoreEvent>) {
        let Some(config) = &self.audio_config else {
            return;
        };

        out.push(CoreEvent::InitSegment(InitSegment {
            track: TrackKind::Audio,
            codec: Fmp4AudioCodec::codec_string(&config.codec).to_string(),
            timescale: audio_timescale(config),
            bytes: build_audio_init_segment(config),
        }));
        self.audio_init_emitted = true;
    }

    fn emit_video_media_segment(
        &mut self,
        mut sample: EncodedSample,
        duration: u32,
        clock: crate::track::TrackClock,
        out: &mut Vec<CoreEvent>,
    ) {
        let duration = duration.max(1);
        sample.set_video_duration(duration);
        let sequence_number = self.next_video_sequence_number;
        self.next_video_sequence_number = self.next_video_sequence_number.saturating_add(1);
        let bytes = build_video_media_segment(sequence_number, &sample, clock);
        let dts_start_ms =
            input_timestamp_to_milliseconds(sample.timing().dts, clock.input_timescale());
        let duration_ms = duration_to_milliseconds(duration, clock.fmp4_timescale());
        out.push(CoreEvent::MediaSegment(MediaSegment {
            track: TrackKind::Video,
            dts_start_ms,
            dts_end_ms: dts_start_ms + duration_ms,
            keyframe: sample.is_sync(),
            bytes,
        }));
        self.last_video_sample_duration = Some(duration);
    }

    pub(crate) fn flush(&mut self, out: &mut Vec<CoreEvent>) -> Result<(), CoreError> {
        if let Some(sample) = self.pending_video_sample.take() {
            let clock = self
                .video_config
                .as_ref()
                .ok_or_else(|| {
                    CoreError::new(
                        CoreErrorCode::InvalidCodecConfig,
                        "Cannot flush video without video configuration.",
                    )
                })?
                .clock;
            let duration = sample
                .duration()
                .or(self.last_video_sample_duration)
                .unwrap_or(1);
            self.emit_video_media_segment(sample, duration, clock, out);
        }
        Ok(())
    }
}

fn infer_video_sample_duration(
    previous: &EncodedSample,
    next: &EncodedSample,
    clock: crate::track::TrackClock,
) -> u32 {
    previous
        .duration()
        .unwrap_or_else(|| input_duration_to_fmp4(next.timing().dts - previous.timing().dts, clock))
}
