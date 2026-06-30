use crate::event::{CoreEvent, CoreWarning, Discontinuity, TrackKind};
use crate::sample::{AudioSample, SampleTiming, VideoSample};

const ROLLBACK_TOLERANCE_MS: i64 = 5;
const GAP_WARNING_THRESHOLD_MS: i64 = 1_000;

#[derive(Debug, Default)]
pub(crate) struct TimestampNormalizer {
    base_dts_ms: Option<i64>,
    last_video_dts_ms: Option<i64>,
    last_audio_dts_ms: Option<i64>,
}

#[derive(Debug)]
pub(crate) struct NormalizedSample<T> {
    pub(crate) sample: T,
    pub(crate) events: Vec<CoreEvent>,
}

impl TimestampNormalizer {
    pub(crate) fn normalize_video_sample(
        &mut self,
        mut sample: VideoSample,
    ) -> NormalizedSample<VideoSample> {
        let events = self.normalize_timing(TrackKind::Video, &mut sample.timing);
        NormalizedSample { sample, events }
    }

    pub(crate) fn normalize_audio_sample(
        &mut self,
        mut sample: AudioSample,
    ) -> NormalizedSample<AudioSample> {
        let events = self.normalize_timing(TrackKind::Audio, &mut sample.timing);
        NormalizedSample { sample, events }
    }

    fn normalize_timing(&mut self, track: TrackKind, timing: &mut SampleTiming) -> Vec<CoreEvent> {
        let input_dts_ms = timing.dts_ms;
        let input_pts_ms = timing.pts_ms;
        let mut events = Vec::new();

        if self.is_rollback(track, input_dts_ms) {
            events.push(CoreEvent::Discontinuity(Discontinuity {
                reason: "timestamp-rollback".to_string(),
            }));
            self.base_dts_ms = Some(input_dts_ms);
            self.last_video_dts_ms = None;
            self.last_audio_dts_ms = None;
        } else if let Some(gap_ms) = self.forward_gap_ms(track, input_dts_ms)
            && gap_ms > GAP_WARNING_THRESHOLD_MS
        {
            events.push(CoreEvent::Warning(CoreWarning::new(
                "RIVMUX_TIMESTAMP_GAP",
                format!(
                    "Detected a {gap_ms} ms {} timestamp gap.",
                    track_label(track)
                ),
            )));
        }

        let base_dts_ms = *self.base_dts_ms.get_or_insert(input_dts_ms);
        timing.dts_ms = input_dts_ms - base_dts_ms;
        timing.pts_ms = input_pts_ms - base_dts_ms;
        if timing.dts_ms < 0 && timing.dts_ms >= -ROLLBACK_TOLERANCE_MS {
            timing.dts_ms = 0;
            timing.pts_ms = timing.pts_ms.max(0);
        }

        self.set_last_dts(track, input_dts_ms);
        events
    }

    fn is_rollback(&self, track: TrackKind, input_dts_ms: i64) -> bool {
        self.last_dts(track)
            .is_some_and(|last_dts_ms| input_dts_ms + ROLLBACK_TOLERANCE_MS < last_dts_ms)
    }

    fn forward_gap_ms(&self, track: TrackKind, input_dts_ms: i64) -> Option<i64> {
        self.last_dts(track)
            .map(|last_dts_ms| input_dts_ms - last_dts_ms)
            .filter(|gap_ms| *gap_ms > 0)
    }

    fn last_dts(&self, track: TrackKind) -> Option<i64> {
        match track {
            TrackKind::Video => self.last_video_dts_ms,
            TrackKind::Audio => self.last_audio_dts_ms,
            TrackKind::Muxed => None,
        }
    }

    fn set_last_dts(&mut self, track: TrackKind, dts_ms: i64) {
        match track {
            TrackKind::Video => self.last_video_dts_ms = Some(dts_ms),
            TrackKind::Audio => self.last_audio_dts_ms = Some(dts_ms),
            TrackKind::Muxed => {}
        }
    }
}

fn track_label(track: TrackKind) -> &'static str {
    match track {
        TrackKind::Video => "video",
        TrackKind::Audio => "audio",
        TrackKind::Muxed => "muxed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::{AudioCodecKind, VideoCodecKind};

    #[test]
    fn normalizes_first_video_dts_to_zero() {
        let mut normalizer = TimestampNormalizer::default();
        let normalized = normalizer.normalize_video_sample(video_sample(10_000, 10_033));

        assert_eq!(normalized.sample.timing.dts_ms, 0);
        assert_eq!(normalized.sample.timing.pts_ms, 33);
        assert!(normalized.events.is_empty());
    }

    #[test]
    fn uses_first_available_media_dts_as_base_across_tracks() {
        let mut normalizer = TimestampNormalizer::default();
        let audio = normalizer.normalize_audio_sample(audio_sample(5_000));
        let video = normalizer.normalize_video_sample(video_sample(5_040, 5_060));

        assert_eq!(audio.sample.timing.dts_ms, 0);
        assert_eq!(audio.sample.timing.pts_ms, 0);
        assert_eq!(video.sample.timing.dts_ms, 40);
        assert_eq!(video.sample.timing.pts_ms, 60);
    }

    #[test]
    fn emits_warning_for_large_forward_gap() {
        let mut normalizer = TimestampNormalizer::default();
        let first = normalizer.normalize_video_sample(video_sample(1_000, 1_000));
        let second = normalizer.normalize_video_sample(video_sample(3_500, 3_500));

        assert!(first.events.is_empty());
        assert_eq!(second.sample.timing.dts_ms, 2_500);
        assert!(matches!(
            second.events.as_slice(),
            [CoreEvent::Warning(warning)] if warning.code == "RIVMUX_TIMESTAMP_GAP"
        ));
    }

    #[test]
    fn emits_discontinuity_and_rebases_after_large_rollback() {
        let mut normalizer = TimestampNormalizer::default();
        let first = normalizer.normalize_video_sample(video_sample(1_000, 1_000));
        let second = normalizer.normalize_video_sample(video_sample(900, 900));

        assert!(first.events.is_empty());
        assert_eq!(second.sample.timing.dts_ms, 0);
        assert_eq!(second.sample.timing.pts_ms, 0);
        assert!(matches!(
            second.events.as_slice(),
            [CoreEvent::Discontinuity(discontinuity)] if discontinuity.reason == "timestamp-rollback"
        ));
    }

    fn video_sample(dts_ms: i64, pts_ms: i64) -> VideoSample {
        VideoSample {
            codec: VideoCodecKind::Avc,
            timing: SampleTiming {
                dts_ms,
                pts_ms,
                duration_ms: None,
            },
            is_keyframe: true,
            data: vec![0x65],
        }
    }

    fn audio_sample(dts_ms: i64) -> AudioSample {
        AudioSample {
            codec: AudioCodecKind::Aac,
            timing: SampleTiming {
                dts_ms,
                pts_ms: dts_ms,
                duration_ms: None,
            },
            sample_rate: 44_100,
            sample_count: 1024,
            data: vec![0x21],
        }
    }
}
