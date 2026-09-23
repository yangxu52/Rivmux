use crate::error::{CoreError, CoreErrorCode};

use super::types::*;

const COMPACT_THRESHOLD: usize = 4096;

#[derive(Debug)]
pub(super) struct FlvParser {
    max_tag_data_size: usize,
    buffer: Vec<u8>,
    start: usize,
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
            start: 0,
            state: FlvParseState::Header,
        }
    }

    pub(super) fn push(&mut self, data: &[u8]) {
        if self.start == self.buffer.len() {
            self.buffer.clear();
            self.start = 0;
        } else if self.start >= COMPACT_THRESHOLD {
            // Move at most once per `COMPACT_THRESHOLD` consumed bytes, so the
            // amortized cost stays linear in the number of bytes pushed.
            self.buffer.drain(..self.start);
            self.start = 0;
        }
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
                FlvParseState::TagBody(header) => return self.parse_tag(header),
            }
        }
    }

    pub(super) fn has_partial_structure(&self) -> bool {
        self.start != self.buffer.len() || !matches!(self.state, FlvParseState::TagHeader)
    }

    fn available(&self) -> &[u8] {
        &self.buffer[self.start..]
    }

    fn consume(&mut self, count: usize) {
        self.start += count;
        if self.start == self.buffer.len() {
            self.buffer.clear();
            self.start = 0;
        }
    }

    fn parse_header(&mut self) -> Result<Option<FlvParserEvent>, CoreError> {
        if self.available().len() < FLV_HEADER_MIN_LEN {
            return Ok(None);
        }

        if &self.available()[0..3] != b"FLV" {
            return Err(CoreError::new(
                CoreErrorCode::UnsupportedContainer,
                "Input is not an FLV stream.",
            ));
        }

        if self.available()[3] != 1 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "Unsupported FLV version.",
            ));
        }

        let expects_audio = self.available()[4] & 0b0000_0100 != 0;
        let expects_video = self.available()[4] & 0b0000_0001 != 0;
        let offset = self.start;
        let data_offset = u32::from_be_bytes([
            self.buffer[offset + 5],
            self.buffer[offset + 6],
            self.buffer[offset + 7],
            self.buffer[offset + 8],
        ]) as usize;
        if data_offset < FLV_HEADER_MIN_LEN {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV data offset is smaller than the fixed header.",
            ));
        }

        if self.available().len() < data_offset {
            return Ok(None);
        }

        self.consume(data_offset);
        self.state = FlvParseState::PreviousTagSize0;
        Ok(Some(FlvParserEvent::Header {
            expects_audio,
            expects_video,
        }))
    }

    fn parse_previous_tag_size0(&mut self) -> Result<bool, CoreError> {
        if self.available().len() < PREVIOUS_TAG_SIZE_LEN {
            return Ok(false);
        }

        let previous_tag_size = read_u32(self.available());
        if previous_tag_size != 0 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV PreviousTagSize0 must be zero.",
            ));
        }

        self.consume(PREVIOUS_TAG_SIZE_LEN);
        self.state = FlvParseState::TagHeader;
        Ok(true)
    }

    fn parse_tag_header(&mut self) -> Result<bool, CoreError> {
        if self.available().len() < TAG_HEADER_LEN {
            return Ok(false);
        }

        let offset = self.start;
        let data_size = read_u24(&self.buffer[offset + 1..offset + 4]) as usize;
        if data_size > self.max_tag_data_size {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV tag data size exceeds the configured limit.",
            ));
        }

        let timestamp_lower = read_u24(&self.buffer[offset + 4..offset + 7]);
        let timestamp_ms = (timestamp_lower | ((self.buffer[offset + 7] as u32) << 24)) as i64;
        let stream_id = read_u24(&self.buffer[offset + 8..offset + 11]);
        if stream_id != 0 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV tag stream id must be zero.",
            ));
        }

        let header = FlvTagHeader {
            tag_type: self.buffer[offset],
            data_size,
            timestamp_ms,
        };
        self.consume(TAG_HEADER_LEN);
        self.state = FlvParseState::TagBody(header);
        Ok(true)
    }

    fn parse_tag(&mut self, header: FlvTagHeader) -> Result<Option<FlvParserEvent>, CoreError> {
        let tag_len = header.data_size + PREVIOUS_TAG_SIZE_LEN;
        if self.available().len() < tag_len {
            return Ok(None);
        }

        let offset = self.start;
        let actual = read_u32(&self.buffer[offset + header.data_size..offset + tag_len]);
        let expected = (TAG_HEADER_LEN + header.data_size) as u32;
        if actual != expected {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV PreviousTagSize does not match the preceding tag.",
            ));
        }

        let payload = self.buffer[offset..offset + header.data_size].to_vec();
        self.consume(tag_len);
        self.state = FlvParseState::TagHeader;
        Ok(Some(FlvParserEvent::Tag { header, payload }))
    }
}
