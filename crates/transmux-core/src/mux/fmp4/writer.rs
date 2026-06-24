use crate::codec::avc::VideoConfig;
use crate::error::{CoreError, CoreErrorCode};
use crate::event::{CoreEvent, CoreWarning, InitSegment, MediaSegment, TrackKind};
use crate::mux::fmp4::init_segment::{build_video_init_segment, video_timescale};
use crate::mux::fmp4::media_segment::{build_video_media_segment, sample_duration};
use crate::sample::VideoSample;

#[derive(Debug, Default)]
pub struct Fmp4Muxer {
    video_config: Option<VideoConfig>,
    next_sequence_number: u32,
    video_started: bool,
}

impl Fmp4Muxer {
    pub fn on_video_config(
        &mut self,
        config: VideoConfig,
        out: &mut Vec<CoreEvent>,
    ) -> Result<(), CoreError> {
        let bytes = build_video_init_segment(&config);
        out.push(CoreEvent::InitSegment(InitSegment {
            track: TrackKind::Video,
            codec: config.codec_string.clone(),
            timescale: video_timescale(),
            bytes,
        }));
        self.video_config = Some(config);
        self.next_sequence_number = 1;
        self.video_started = false;
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

        let sequence_number = self.next_sequence_number;
        self.next_sequence_number = self.next_sequence_number.saturating_add(1);
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

    pub fn flush(&mut self, _out: &mut Vec<CoreEvent>) -> Result<(), CoreError> {
        Ok(())
    }
}
