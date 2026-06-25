use crate::demux::flv::FlvDemuxer;
use crate::error::CoreError;
use crate::event::CoreEvent;
use crate::mux::fmp4::Fmp4Muxer;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreConfig {
    pub max_tag_data_size: usize,
}

impl Default for CoreConfig {
    fn default() -> Self {
        Self {
            max_tag_data_size: 16 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Default)]
pub struct TransmuxCore {
    config: CoreConfig,
    demuxer: FlvDemuxer,
    muxer: Fmp4Muxer,
    events: Vec<CoreEvent>,
}

impl TransmuxCore {
    #[must_use]
    pub fn new(config: CoreConfig) -> Self {
        Self {
            demuxer: FlvDemuxer::new(config.max_tag_data_size),
            muxer: Fmp4Muxer::default(),
            config,
            events: Vec::new(),
        }
    }

    pub fn push_chunk(&mut self, data: &[u8]) -> Result<(), CoreError> {
        let mut demux_events = Vec::new();
        let demux_result = self.demuxer.push(data, &mut demux_events);
        self.capture_result(demux_result)?;
        self.process_demux_events(demux_events)
    }

    pub fn drain_events(&mut self, out: &mut Vec<CoreEvent>) {
        out.append(&mut self.events);
    }

    pub fn flush(&mut self) -> Result<(), CoreError> {
        let mut demux_events = Vec::new();
        let demux_result = self.demuxer.flush(&mut demux_events);
        self.capture_result(demux_result)?;
        self.process_demux_events(demux_events)?;
        let mut mux_events = Vec::new();
        let mux_result = self.muxer.flush(&mut mux_events);
        self.events.extend(mux_events);
        self.capture_result(mux_result)
    }

    pub fn reset(&mut self) {
        self.demuxer = FlvDemuxer::new(self.config.max_tag_data_size);
        self.muxer = Fmp4Muxer::default();
        self.events.clear();
    }

    fn process_demux_events(&mut self, demux_events: Vec<CoreEvent>) -> Result<(), CoreError> {
        for event in demux_events {
            match &event {
                CoreEvent::VideoConfig(config) => {
                    self.events.push(event.clone());
                    let mut mux_events = Vec::new();
                    let mux_result = self.muxer.on_video_config(config.clone(), &mut mux_events);
                    self.events.extend(mux_events);
                    self.capture_result(mux_result)?;
                }
                CoreEvent::VideoSample(sample) => {
                    self.events.push(event.clone());
                    let mut mux_events = Vec::new();
                    let mux_result = self.muxer.push_video(sample.clone(), &mut mux_events);
                    self.events.extend(mux_events);
                    self.capture_result(mux_result)?;
                }
                CoreEvent::AudioConfig(config) => {
                    self.events.push(event.clone());
                    let mut mux_events = Vec::new();
                    let mux_result = self.muxer.on_audio_config(config.clone(), &mut mux_events);
                    self.events.extend(mux_events);
                    self.capture_result(mux_result)?;
                }
                CoreEvent::AudioSample(sample) => {
                    self.events.push(event.clone());
                    let mut mux_events = Vec::new();
                    let mux_result = self.muxer.push_audio(sample.clone(), &mut mux_events);
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
