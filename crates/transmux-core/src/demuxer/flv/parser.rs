use crate::error::{CoreError, CoreErrorCode};

use super::types::*;

#[derive(Debug)]
pub(super) struct FlvParser {
    max_tag_data_size: usize,
    buffer: Vec<u8>,
    state: FlvParseState,
}

#[derive(Debug)]
pub(super) enum FlvParserEvent {
    Header {
        expects_audio: bool,
        expects_video: bool,
    },
    Tag {
        header: FlvTagHeader,
        payload: Vec<u8>,
    },
}

impl FlvParser {
    pub(super) fn new(max_tag_data_size: usize) -> Self {
        Self {
            max_tag_data_size,
            buffer: Vec::new(),
            state: FlvParseState::Header,
        }
    }

    pub(super) fn push(&mut self, data: &[u8]) {
        self.buffer.extend_from_slice(data);
    }

    pub(super) fn next_event(&mut self) -> Result<Option<FlvParserEvent>, CoreError> {
        loop {
            match self.state {
                FlvParseState::Header => return self.parse_header(),
                FlvParseState::PreviousTagSize0 => {
                    if !self.parse_previous_tag_size0()? {
                        return Ok(None);
                    }
                }
                FlvParseState::TagHeader => {
                    if !self.parse_tag_header()? {
                        return Ok(None);
                    }
                }
                FlvParseState::TagBody(header) => return Ok(self.parse_tag_body(header)),
                FlvParseState::PreviousTagSize(header) => {
                    if !self.parse_previous_tag_size(header)? {
                        return Ok(None);
                    }
                }
            }
        }
    }

    pub(super) fn has_buffered_data(&self) -> bool {
        !self.buffer.is_empty()
    }

    fn parse_header(&mut self) -> Result<Option<FlvParserEvent>, CoreError> {
        if self.buffer.len() < FLV_HEADER_MIN_LEN {
            return Ok(None);
        }

        if &self.buffer[0..3] != b"FLV" {
            return Err(CoreError::new(
                CoreErrorCode::UnsupportedContainer,
                "Input is not an FLV stream.",
            ));
        }

        if self.buffer[3] != 1 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "Unsupported FLV version.",
            ));
        }

        let expects_audio = self.buffer[4] & 0b0000_0100 != 0;
        let expects_video = self.buffer[4] & 0b0000_0001 != 0;
        let data_offset = u32::from_be_bytes([
            self.buffer[5],
            self.buffer[6],
            self.buffer[7],
            self.buffer[8],
        ]) as usize;
        if data_offset < FLV_HEADER_MIN_LEN {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV data offset is smaller than the fixed header.",
            ));
        }

        if self.buffer.len() < data_offset {
            return Ok(None);
        }

        self.buffer.drain(0..data_offset);
        self.state = FlvParseState::PreviousTagSize0;
        Ok(Some(FlvParserEvent::Header {
            expects_audio,
            expects_video,
        }))
    }

    fn parse_previous_tag_size0(&mut self) -> Result<bool, CoreError> {
        if self.buffer.len() < PREVIOUS_TAG_SIZE_LEN {
            return Ok(false);
        }

        let previous_tag_size = read_u32(&self.buffer[0..4]);
        if previous_tag_size != 0 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV PreviousTagSize0 must be zero.",
            ));
        }

        self.buffer.drain(0..PREVIOUS_TAG_SIZE_LEN);
        self.state = FlvParseState::TagHeader;
        Ok(true)
    }

    fn parse_tag_header(&mut self) -> Result<bool, CoreError> {
        if self.buffer.len() < TAG_HEADER_LEN {
            return Ok(false);
        }

        let data_size = read_u24(&self.buffer[1..4]) as usize;
        if data_size > self.max_tag_data_size {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV tag data size exceeds the configured limit.",
            ));
        }

        let timestamp_lower = read_u24(&self.buffer[4..7]);
        let timestamp_ms = (timestamp_lower | ((self.buffer[7] as u32) << 24)) as i64;
        let stream_id = read_u24(&self.buffer[8..11]);
        if stream_id != 0 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV tag stream id must be zero.",
            ));
        }

        let header = FlvTagHeader {
            tag_type: self.buffer[0],
            data_size,
            timestamp_ms,
        };
        self.buffer.drain(0..TAG_HEADER_LEN);
        self.state = FlvParseState::TagBody(header);
        Ok(true)
    }

    fn parse_tag_body(&mut self, header: FlvTagHeader) -> Option<FlvParserEvent> {
        if self.buffer.len() < header.data_size {
            return None;
        }

        let payload = self.buffer.drain(0..header.data_size).collect();
        self.state = FlvParseState::PreviousTagSize(header);
        Some(FlvParserEvent::Tag { header, payload })
    }

    fn parse_previous_tag_size(&mut self, header: FlvTagHeader) -> Result<bool, CoreError> {
        if self.buffer.len() < PREVIOUS_TAG_SIZE_LEN {
            return Ok(false);
        }

        let actual = read_u32(&self.buffer[0..4]);
        let expected = (TAG_HEADER_LEN + header.data_size) as u32;
        if actual != expected {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV PreviousTagSize does not match the preceding tag.",
            ));
        }

        self.buffer.drain(0..PREVIOUS_TAG_SIZE_LEN);
        self.state = FlvParseState::TagHeader;
        Ok(true)
    }
}
