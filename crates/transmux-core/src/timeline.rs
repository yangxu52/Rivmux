use crate::event::{CoreEvent, CoreWarning, Discontinuity};
use crate::sample::{EncodedSample, SampleTiming};
use crate::track::{MediaKind, TrackConfig};

const DEFAULT_INPUT_TIMESCALE: u32 = 1_000;
const ROLLBACK_TOLERANCE_MS: u32 = 5;
const GAP_WARNING_THRESHOLD_MS: i64 = 1_000;

#[derive(Debug, Default)]
pub(crate) struct TimestampNormalizer {
    base_dts: Option<i64>,
    last_video_dts: Option<i64>,
    last_audio_dts: Option<i64>,
    video_input_timescale: Option<u32>,
    audio_input_timescale: Option<u32>,
}

#[derive(Debug)]
pub(crate) struct NormalizedSample {
    pub(crate) sample: EncodedSample,
    pub(crate) events: Vec<CoreEvent>,
}

impl TimestampNormalizer {
    pub(crate) fn on_track_config(&mut self, config: &TrackConfig) {
        match config {
            TrackConfig::Video(config) => {
                self.video_input_timescale = Some(config.clock.input_timescale());
            }
            TrackConfig::Audio(config) => {
                self.audio_input_timescale = Some(config.clock.input_timescale());
            }
        }
    }

    pub(crate) fn normalize_sample(&mut self, mut sample: EncodedSample) -> NormalizedSample {
        let events = self.normalize_timing(sample.kind(), sample.timing_mut());
        NormalizedSample { sample, events }
    }

    fn normalize_timing(&mut self, track: MediaKind, timing: &mut SampleTiming) -> Vec<CoreEvent> {
        let input_dts = timing.dts;
        let input_pts = timing.pts;
        let input_timescale = self.input_timescale(track);
        let mut events = Vec::new();

        if self.is_rollback(track, input_dts, input_timescale) {
            events.push(CoreEvent::Discontinuity(Discontinuity {
                reason: "timestamp-rollback".to_string(),
            }));
            self.base_dts = Some(input_dts);
            self.last_video_dts = None;
            self.last_audio_dts = None;
        } else if let Some(gap) = self.forward_gap(track, input_dts)
            && gap > milliseconds_to_ticks(GAP_WARNING_THRESHOLD_MS, input_timescale)
        {
            let gap_ms = ticks_to_milliseconds(gap, input_timescale);
            events.push(CoreEvent::Warning(CoreWarning::new(
                "RIVMUX_TIMESTAMP_GAP",
                format!(
                    "Detected a {gap_ms} ms {} timestamp gap.",
                    track_label(track)
                ),
            )));
        }

        let base_dts = *self.base_dts.get_or_insert(input_dts);
        timing.dts = input_dts - base_dts;
        timing.pts = input_pts - base_dts;
        if timing.dts < 0
            && timing.dts
                >= -milliseconds_to_ticks(i64::from(ROLLBACK_TOLERANCE_MS), input_timescale)
        {
            timing.dts = 0;
            timing.pts = timing.pts.max(0);
        }

        self.set_last_dts(track, input_dts);
        events
    }

    fn is_rollback(&self, track: MediaKind, input_dts: i64, input_timescale: u32) -> bool {
        self.last_dts(track).is_some_and(|last_dts| {
            input_dts + milliseconds_to_ticks(i64::from(ROLLBACK_TOLERANCE_MS), input_timescale)
                < last_dts
        })
    }

    fn forward_gap(&self, track: MediaKind, input_dts: i64) -> Option<i64> {
        self.last_dts(track)
            .map(|last_dts| input_dts - last_dts)
            .filter(|gap| *gap > 0)
    }

    fn last_dts(&self, track: MediaKind) -> Option<i64> {
        match track {
            MediaKind::Video => self.last_video_dts,
            MediaKind::Audio => self.last_audio_dts,
        }
    }

    fn set_last_dts(&mut self, track: MediaKind, dts: i64) {
        match track {
            MediaKind::Video => self.last_video_dts = Some(dts),
            MediaKind::Audio => self.last_audio_dts = Some(dts),
        }
    }

    fn input_timescale(&self, track: MediaKind) -> u32 {
        match track {
            MediaKind::Video => self.video_input_timescale,
            MediaKind::Audio => self.audio_input_timescale,
        }
        .unwrap_or(DEFAULT_INPUT_TIMESCALE)
    }
}

fn track_label(track: MediaKind) -> &'static str {
    match track {
        MediaKind::Video => "video",
        MediaKind::Audio => "audio",
    }
}

fn milliseconds_to_ticks(milliseconds: i64, timescale: u32) -> i64 {
    (i128::from(milliseconds) * i128::from(timescale) / 1_000)
        .clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
}

fn ticks_to_milliseconds(ticks: i64, timescale: u32) -> i64 {
    (i128::from(ticks) * 1_000 / i128::from(timescale.max(1)))
        .clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AvcConfig, TrackClock, TrackConfig, TrackId, VideoCodecConfig, VideoTrackConfig};

    #[test]
    fn normalizes_first_video_dts_to_zero() {
        let mut normalizer = TimestampNormalizer::default();
        let normalized = normalizer.normalize_sample(video_sample(10_000, 10_033));

        assert_eq!(normalized.sample.timing().dts, 0);
        assert_eq!(normalized.sample.timing().pts, 33);
        assert!(normalized.events.is_empty());
    }

    #[test]
    fn uses_first_available_media_dts_as_base_across_tracks() {
        let mut normalizer = TimestampNormalizer::default();
        let audio = normalizer.normalize_sample(audio_sample(5_000));
        let video = normalizer.normalize_sample(video_sample(5_040, 5_060));

        assert_eq!(audio.sample.timing().dts, 0);
        assert_eq!(audio.sample.timing().pts, 0);
        assert_eq!(video.sample.timing().dts, 40);
        assert_eq!(video.sample.timing().pts, 60);
    }

    #[test]
    fn emits_warning_for_large_forward_gap() {
        let mut normalizer = TimestampNormalizer::default();
        let first = normalizer.normalize_sample(video_sample(1_000, 1_000));
        let second = normalizer.normalize_sample(video_sample(3_500, 3_500));

        assert!(first.events.is_empty());
        assert_eq!(second.sample.timing().dts, 2_500);
        assert!(matches!(
            second.events.as_slice(),
            [CoreEvent::Warning(warning)] if warning.code == "RIVMUX_TIMESTAMP_GAP"
        ));
    }

    #[test]
    fn emits_discontinuity_and_rebases_after_large_rollback() {
        let mut normalizer = TimestampNormalizer::default();
        let first = normalizer.normalize_sample(video_sample(1_000, 1_000));
        let second = normalizer.normalize_sample(video_sample(900, 900));

        assert!(first.events.is_empty());
        assert_eq!(second.sample.timing().dts, 0);
        assert_eq!(second.sample.timing().pts, 0);
        assert!(matches!(
            second.events.as_slice(),
            [CoreEvent::Discontinuity(discontinuity)] if discontinuity.reason == "timestamp-rollback"
        ));
    }

    #[test]
    fn applies_registered_track_timescale_to_gap_detection() {
        let mut normalizer = TimestampNormalizer::default();
        normalizer.on_track_config(&mpegts_video_track());

        let first = normalizer.normalize_sample(video_sample(90_000, 90_000));
        let second = normalizer.normalize_sample(video_sample(270_000, 270_000));

        assert!(first.events.is_empty());
        assert!(matches!(
            second.events.as_slice(),
            [CoreEvent::Warning(warning)]
                if warning.message == "Detected a 2000 ms video timestamp gap."
        ));
    }

    fn video_sample(dts: i64, pts: i64) -> EncodedSample {
        EncodedSample::Video {
            track_id: TrackId::VIDEO,
            timing: SampleTiming { dts, pts },
            duration: None,
            is_sync: true,
            data: vec![0x65],
        }
    }

    fn audio_sample(dts: i64) -> EncodedSample {
        EncodedSample::Audio {
            track_id: TrackId::AUDIO,
            timing: SampleTiming { dts, pts: dts },
            duration: 1024,
            data: vec![0x21],
        }
    }

    fn mpegts_video_track() -> TrackConfig {
        TrackConfig::Video(VideoTrackConfig {
            id: TrackId::VIDEO,
            clock: TrackClock::new(90_000, 90_000).unwrap(),
            codec: VideoCodecConfig::Avc(AvcConfig {
                codec_string: "avc1.42E01E".to_string(),
                width: None,
                height: None,
                nal_length_size: 4,
                avcc: Vec::new(),
            }),
        })
    }
}
