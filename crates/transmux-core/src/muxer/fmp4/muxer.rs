use crate::error::{CoreError, CoreErrorCode};
use crate::event::{CoreEvent, CoreWarning, InitSegment, MediaSegment, TrackKind};
use crate::muxer::fmp4::init_segment::{
    Fmp4AudioCodec, Fmp4VideoCodec, audio_timescale, build_audio_init_segment,
    build_muxed_init_segment, build_video_init_segment, video_timescale,
};
use crate::muxer::fmp4::media_segment::{
    audio_sample_duration, build_audio_media_segment, build_video_media_segment,
    duration_to_milliseconds, input_duration_to_fmp4, input_timestamp_to_milliseconds,
};
use crate::sample::EncodedSample;
use crate::track::{AudioTrackConfig, MediaKind, TrackConfig, VideoTrackConfig};

const MAX_PENDING_SAMPLES_BEFORE_INITIALIZATION_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Default)]
pub(crate) struct Fmp4Muxer {
    video_config: Option<VideoTrackConfig>,
    audio_config: Option<AudioTrackConfig>,
    next_video_sequence_number: u32,
    next_audio_sequence_number: u32,
    video_started: bool,
    expects_video: bool,
    expects_audio: bool,
    init_segment_mode: InitSegmentMode,
    pending_samples_before_initialization: Vec<EncodedSample>,
    pending_samples_before_initialization_bytes: usize,
    pending_video_sample: Option<EncodedSample>,
    last_video_sample_duration: Option<u32>,
}

impl Fmp4Muxer {
    pub(crate) fn set_expected_tracks(&mut self, expects_video: bool, expects_audio: bool) {
        self.expects_video |= expects_video;
        self.expects_audio |= expects_audio;
    }

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
        out: &mut Vec<CoreEvent>,
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
        if self.init_segment_mode != InitSegmentMode::None {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV video configuration arrived after initialization.",
            ));
        }
        self.video_config = Some(config);
        self.next_video_sequence_number = 1;
        self.video_started = false;
        self.pending_video_sample = None;
        self.last_video_sample_duration = None;
        self.emit_initial_segment_if_ready(out);
        self.flush_pending_samples_before_initialization(out)?;
        Ok(())
    }

    fn on_audio_config(
        &mut self,
        config: AudioTrackConfig,
        out: &mut Vec<CoreEvent>,
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
        if self.init_segment_mode != InitSegmentMode::None {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV audio configuration arrived after initialization.",
            ));
        }
        self.audio_config = Some(config);
        self.next_audio_sequence_number = 1;
        self.emit_initial_segment_if_ready(out);
        self.flush_pending_samples_before_initialization(out)?;
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

        if !self.has_all_declared_track_configs() {
            self.queue_sample_before_initialization(sample)?;
            return Ok(());
        }

        self.push_initialized_video(sample, clock, out);
        Ok(())
    }

    fn push_initialized_video(
        &mut self,
        sample: EncodedSample,
        clock: crate::track::TrackClock,
        out: &mut Vec<CoreEvent>,
    ) {
        self.ensure_video_init_segment(out);
        if let Some(previous) = self.pending_video_sample.take() {
            let duration = infer_video_sample_duration(&previous, &sample, clock);
            self.emit_video_media_segment(previous, duration, clock, out);
        }
        self.pending_video_sample = Some(sample);
    }

    fn queue_sample_before_initialization(
        &mut self,
        sample: EncodedSample,
    ) -> Result<(), CoreError> {
        let next_bytes = self
            .pending_samples_before_initialization_bytes
            .saturating_add(sample.data().len());
        if next_bytes > MAX_PENDING_SAMPLES_BEFORE_INITIALIZATION_BYTES {
            return Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "Declared FLV track configuration did not arrive before the startup buffer limit.",
            ));
        }

        self.pending_samples_before_initialization_bytes = next_bytes;
        self.pending_samples_before_initialization.push(sample);
        Ok(())
    }

    fn flush_pending_samples_before_initialization(
        &mut self,
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        if !self.has_all_declared_track_configs() {
            return Ok(());
        }

        let pending_samples = std::mem::take(&mut self.pending_samples_before_initialization);
        self.pending_samples_before_initialization_bytes = 0;
        for sample in pending_samples {
            match sample.kind() {
                MediaKind::Video => {
                    let clock = self
                        .video_config
                        .as_ref()
                        .ok_or_else(|| {
                            CoreError::new(
                                CoreErrorCode::InvalidCodecConfig,
                                "Cannot mux queued video without video configuration.",
                            )
                        })?
                        .clock;
                    self.push_initialized_video(sample, clock, out);
                }
                MediaKind::Audio => {
                    let clock = self
                        .audio_config
                        .as_ref()
                        .ok_or_else(|| {
                            CoreError::new(
                                CoreErrorCode::InvalidCodecConfig,
                                "Cannot mux queued audio without audio configuration.",
                            )
                        })?
                        .clock;
                    self.push_initialized_audio(sample, clock, out);
                }
            }
        }
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

        if !self.has_all_declared_track_configs() {
            self.queue_sample_before_initialization(sample)?;
            return Ok(());
        }

        self.push_initialized_audio(sample, clock, out);
        Ok(())
    }

    fn push_initialized_audio(
        &mut self,
        sample: EncodedSample,
        clock: crate::track::TrackClock,
        out: &mut Vec<CoreEvent>,
    ) {
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
    }

    fn ensure_video_init_segment(&mut self, out: &mut Vec<CoreEvent>) {
        self.emit_initial_segment_if_ready(out);
    }

    fn ensure_audio_init_segment(&mut self, out: &mut Vec<CoreEvent>) {
        self.emit_initial_segment_if_ready(out);
    }

    fn has_all_declared_track_configs(&self) -> bool {
        (!self.expects_video || self.video_config.is_some())
            && (!self.expects_audio || self.audio_config.is_some())
    }

    fn emit_initial_segment_if_ready(&mut self, out: &mut Vec<CoreEvent>) {
        if self.init_segment_mode != InitSegmentMode::None || !self.has_all_declared_track_configs()
        {
            return;
        }

        match (&self.video_config, &self.audio_config) {
            (Some(_), Some(_)) => self.emit_muxed_init_segment(out),
            (Some(_), None) => self.emit_video_init_segment(out),
            (None, Some(_)) => self.emit_audio_init_segment(out),
            (None, None) => {}
        }
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
        self.init_segment_mode = InitSegmentMode::Video;
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
                Fmp4VideoCodec::codec_string(&video_config.codec),
                Fmp4AudioCodec::codec_string(&audio_config.codec)
            ),
            timescale: video_timescale(video_config),
            bytes: build_muxed_init_segment(video_config, audio_config),
        }));
        self.init_segment_mode = InitSegmentMode::Muxed;
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
        if !self.pending_samples_before_initialization.is_empty() {
            return Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "FLV input ended before all declared tracks provided their configuration.",
            ));
        }
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum InitSegmentMode {
    #[default]
    None,
    Video,
    Audio,
    Muxed,
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
