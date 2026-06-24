use crate::demux::flv::FlvDemuxer;
use crate::error::CoreError;
use crate::event::CoreEvent;

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
    events: Vec<CoreEvent>,
}

impl TransmuxCore {
    #[must_use]
    pub fn new(config: CoreConfig) -> Self {
        Self {
            demuxer: FlvDemuxer::new(config.max_tag_data_size),
            config,
            events: Vec::new(),
        }
    }

    pub fn push_chunk(&mut self, data: &[u8]) -> Result<(), CoreError> {
        match self.demuxer.push(data, &mut self.events) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.events.push(CoreEvent::FatalError(error.clone()));
                Err(error)
            }
        }
    }

    pub fn drain_events(&mut self, out: &mut Vec<CoreEvent>) {
        out.append(&mut self.events);
    }

    pub fn flush(&mut self) -> Result<(), CoreError> {
        match self.demuxer.flush(&mut self.events) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.events.push(CoreEvent::FatalError(error.clone()));
                Err(error)
            }
        }
    }

    pub fn reset(&mut self) {
        self.demuxer = FlvDemuxer::new(self.config.max_tag_data_size);
        self.events.clear();
    }
}
