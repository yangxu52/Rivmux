use crate::demuxer::flv::FlvDemuxer;
use crate::error::CoreError;
use crate::event::CoreEvent;
use crate::muxer::fmp4::Fmp4Muxer;
use crate::timeline::TimestampNormalizer;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreConfig {
    pub max_tag_data_size: usize,
    /// Emits a `CoreEvent::Sample` for every normalized sample.
    ///
    /// The browser runtime only consumes init and media segments, and each
    /// sample event duplicates the encoded payload across the WASM boundary.
    /// The WASM adapter therefore disables this; the Rust default keeps it on
    /// for inspection and testing.
    pub emit_samples: bool,
}

impl Default for CoreConfig {
    fn default() -> Self {
        Self {
            max_tag_data_size: 16 * 1024 * 1024,
            emit_samples: true,
        }
    }
}

#[derive(Debug, Default)]
pub struct TransmuxCore {
    config: CoreConfig,
    demuxer: FlvDemuxer,
    timeline: TimestampNormalizer,
    muxer: Fmp4Muxer,
    events: Vec<CoreEvent>,
}

impl TransmuxCore {
    #[must_use]
    pub fn new(config: CoreConfig) -> Self {
        Self {
            demuxer: FlvDemuxer::new(config.max_tag_data_size),
            timeline: TimestampNormalizer::default(),
            muxer: Fmp4Muxer::default(),
            config,
            events: Vec::new(),
        }
    }

    pub fn push_chunk(&mut self, data: &[u8]) -> Result<(), CoreError> {
        let mut demux_events = Vec::new();
        let demux_result = self.demuxer.push(data, &mut demux_events);
        self.muxer
            .set_expected_tracks(self.demuxer.expects_video(), self.demuxer.expects_audio());
        // Deliver every event that was parsed before the failure instead of
        // dropping the whole batch. The error is still reported through the
        // return value and a `FatalError` event, matching mux-stage failures.
        let process_result = self.process_demux_events(demux_events);
        match demux_result {
            Ok(()) => process_result,
            Err(error) => self.capture_result(Err(error)),
        }
    }

    pub fn drain_events(&mut self, out: &mut Vec<CoreEvent>) {
        out.append(&mut self.events);
    }

    pub fn flush(&mut self) -> Result<(), CoreError> {
        let mut demux_events = Vec::new();
        let demux_result = self.demuxer.flush(&mut demux_events);
        let process_result = self.process_demux_events(demux_events);
        if let Err(error) = demux_result {
            return self.capture_result(Err(error));
        }
        process_result?;
        let mut mux_events = Vec::new();
        let mux_result = self.muxer.flush(&mut mux_events);
        self.events.extend(mux_events);
        self.capture_result(mux_result)
    }

    pub fn reset(&mut self) {
        self.demuxer = FlvDemuxer::new(self.config.max_tag_data_size);
        self.timeline = TimestampNormalizer::default();
        self.muxer = Fmp4Muxer::default();
        self.events.clear();
    }

    fn process_demux_events(&mut self, demux_events: Vec<CoreEvent>) -> Result<(), CoreError> {
        for event in demux_events {
            match event {
                CoreEvent::TrackConfig(config) => {
                    let mut mux_events = Vec::new();
                    let mux_result = self.muxer.on_track_config(config.clone(), &mut mux_events);
                    self.capture_result(mux_result)?;
                    self.timeline.on_track_config(&config);
                    self.events.push(CoreEvent::TrackConfig(config));
                    self.events.extend(mux_events);
                }
                CoreEvent::Sample(sample) => {
                    let normalized = self.timeline.normalize_sample(sample);
                    self.events.extend(normalized.events);
                    let sample = normalized.sample;
                    if self.config.emit_samples {
                        self.events.push(CoreEvent::Sample(sample.clone()));
                    }
                    let mut mux_events = Vec::new();
                    let mux_result = self.muxer.push_sample(sample, &mut mux_events);
                    self.events.extend(mux_events);
                    self.capture_result(mux_result)?;
                }
                _ => self.events.push(event),
            }
        }

        Ok(())
    }

    fn capture_result(&mut self, result: Result<(), CoreError>) -> Result<(), CoreError> {
        match result {
            Ok(()) => Ok(()),
            Err(error) => {
                self.events.push(CoreEvent::FatalError(error.clone()));
                Err(error)
            }
        }
    }
}
