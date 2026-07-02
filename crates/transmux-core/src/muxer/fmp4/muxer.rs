use crate::codec::aac::AudioConfig;
use crate::codec::avc::VideoConfig;
use crate::error::{CoreError, CoreErrorCode};
use crate::event::{CoreEvent, CoreWarning, InitSegment, MediaSegment, TrackKind};
use crate::muxer::fmp4::init_segment::{
    audio_timescale, build_audio_init_segment, build_video_init_segment, video_timescale,
};
use crate::muxer::fmp4::media_segment::{
    audio_sample_duration_ms, build_audio_media_segment, build_video_media_segment,
};
use crate::sample::{AudioSample, VideoSample};

#[derive(Debug, Default)]
pub(crate) struct Fmp4Muxer {
    video_config: Option<VideoConfig>,
    audio_config: Option<AudioConfig>,
    next_video_sequence_number: u32,
    next_audio_sequence_number: u32,
    video_started: bool,
    video_init_emitted: bool,
    audio_init_emitted: bool,
    pending_video_sample: Option<VideoSample>,
    last_video_sample_duration_ms: Option<i64>,
}

impl Fmp4Muxer {
    pub(crate) fn on_video_config(
        &mut self,
        config: VideoConfig,
        _out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        self.video_config = Some(config);
        self.next_video_sequence_number = 1;
        self.video_started = false;
        self.video_init_emitted = false;
        self.pending_video_sample = None;
        self.last_video_sample_duration_ms = None;
        Ok(())
    }

    pub(crate) fn on_audio_config(
        &mut self,
        config: AudioConfig,
        _out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        self.audio_config = Some(config);
        self.next_audio_sequence_number = 1;
        self.audio_init_emitted = false;
        Ok(())
    }

    pub(crate) fn push_video(
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
        if let Some(previous) = self.pending_video_sample.take() {
            let duration_ms = infer_video_sample_duration(&previous, &sample);
            self.emit_video_media_segment(previous, duration_ms, out);
        }
        self.pending_video_sample = Some(sample);
        Ok(())
    }

    pub(crate) fn push_audio(
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
            codec: config.codec_string.clone(),
            timescale: video_timescale(),
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
            codec: config.codec_string.clone(),
            timescale: audio_timescale(config),
            bytes: build_audio_init_segment(config),
        }));
        self.audio_init_emitted = true;
    }

    fn emit_video_media_segment(
        &mut self,
        mut sample: VideoSample,
        duration_ms: i64,
        out: &mut Vec<CoreEvent>,
    ) {
        let duration_ms = duration_ms.max(1);
        sample.timing.duration_ms = Some(duration_ms);
        let sequence_number = self.next_video_sequence_number;
        self.next_video_sequence_number = self.next_video_sequence_number.saturating_add(1);
        let bytes = build_video_media_segment(sequence_number, &sample);
        out.push(CoreEvent::MediaSegment(MediaSegment {
            track: TrackKind::Video,
            dts_start_ms: sample.timing.dts_ms,
            dts_end_ms: sample.timing.dts_ms + duration_ms,
            keyframe: sample.is_keyframe,
            bytes,
        }));
        self.last_video_sample_duration_ms = Some(duration_ms);
    }

    pub(crate) fn flush(&mut self, out: &mut Vec<CoreEvent>) -> Result<(), CoreError> {
        if let Some(sample) = self.pending_video_sample.take() {
            let duration_ms = sample
                .timing
                .duration_ms
                .or(self.last_video_sample_duration_ms)
                .unwrap_or(1);
            self.emit_video_media_segment(sample, duration_ms, out);
        }
        Ok(())
    }
}

fn infer_video_sample_duration(previous: &VideoSample, next: &VideoSample) -> i64 {
    previous
        .timing
        .duration_ms
        .unwrap_or(next.timing.dts_ms - previous.timing.dts_ms)
        .max(1)
}
