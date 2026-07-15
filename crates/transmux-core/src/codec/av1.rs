use crate::codec::VideoCodecConfig;
use crate::codec::normalizer::{
    VideoAccessUnit, VideoAccessUnitNormalizer, VideoNormalizerEvent, VideoSampleData,
};
use crate::error::{CoreError, CoreErrorCode};
use crate::sample::EncodedSample;

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Av1Config {
    pub codec_string: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub av1c: Vec<u8>,
}

impl Av1Config {
    pub(crate) fn from_av1c(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() < 4 {
            return Err(invalid_config("AV1CodecConfigurationRecord is too short."));
        }
        if data[0] & 0x80 == 0 || data[0] & 0x7F != 1 {
            return Err(invalid_config(
                "Unsupported AV1CodecConfigurationRecord marker or version.",
            ));
        }
        if data[3] & 0xE0 != 0 {
            return Err(invalid_config(
                "AV1CodecConfigurationRecord has non-zero reserved bits.",
            ));
        }
        if data[3] & 0x10 == 0 && data[3] & 0x0F != 0 {
            return Err(invalid_config(
                "AV1CodecConfigurationRecord has an initial presentation delay without its flag.",
            ));
        }

        let seq_profile = data[1] >> 5;
        if seq_profile > 2 {
            return Err(invalid_config(
                "AV1CodecConfigurationRecord has an unsupported sequence profile.",
            ));
        }
        let seq_level_idx_0 = data[1] & 0x1F;
        let seq_tier_0 = data[2] & 0x80 != 0;
        let high_bitdepth = data[2] & 0x40 != 0;
        let twelve_bit = data[2] & 0x20 != 0;
        if twelve_bit && !high_bitdepth {
            return Err(invalid_config(
                "AV1CodecConfigurationRecord sets twelve_bit without high_bitdepth.",
            ));
        }
        let bit_depth = match (high_bitdepth, twelve_bit) {
            (false, false) => 8,
            (true, false) => 10,
            (true, true) => 12,
            (false, true) => unreachable!("twelve_bit without high_bitdepth is rejected above"),
        };
        let tier = if seq_tier_0 { 'H' } else { 'M' };

        let (width, height) = sequence_header_dimensions(&data[4..])
            .map_err(|error| CoreError::new(CoreErrorCode::InvalidCodecConfig, error.message))?
            .map_or((None, None), |(width, height)| (Some(width), Some(height)));

        Ok(Self {
            codec_string: format!("av01.{seq_profile}.{seq_level_idx_0:02}{tier}.{bit_depth:02}"),
            width,
            height,
            av1c: data.to_vec(),
        })
    }
}

#[derive(Debug, Default)]
pub(crate) struct Av1Normalizer {
    config: Option<Av1Config>,
    configuration_emitted: bool,
}

impl VideoAccessUnitNormalizer for Av1Normalizer {
    fn on_configuration(
        &mut self,
        data: &[u8],
        out: &mut Vec<VideoNormalizerEvent>,
    ) -> Result<(), CoreError> {
        let config = Av1Config::from_av1c(data)?;
        match &self.config {
            None => self.config = Some(config),
            Some(previous) if previous == &config => {}
            Some(previous)
                if !self.configuration_emitted
                    && previous.width.is_none()
                    && previous.height.is_none()
                    && config.width.is_some()
                    && config.height.is_some() =>
            {
                self.config = Some(config);
            }
            Some(_) => {
                return Err(invalid_config(
                    "AV1 configuration changes after initialization are not supported.",
                ));
            }
        }
        self.emit_configuration_if_ready(out);
        Ok(())
    }

    fn push_access_unit(
        &mut self,
        unit: VideoAccessUnit<'_>,
        out: &mut Vec<VideoNormalizerEvent>,
    ) -> Result<(), CoreError> {
        if self.config.is_none() {
            return Err(invalid_config(
                "AV1 media sample arrived before AV1CodecConfigurationRecord.",
            ));
        }

        let data = match unit.data {
            VideoSampleData::ObuTemporalUnit(data) => data,
            VideoSampleData::LengthPrefixedNalus(_) | VideoSampleData::AnnexB(_) => {
                return Err(invalid_container(
                    "AV1 normalizer received NAL-unit sample data.",
                ));
            }
        };
        validate_obu_temporal_unit(data)?;
        self.complete_configuration_from_temporal_unit(data, out)?;
        out.push(VideoNormalizerEvent::Sample(EncodedSample::Video {
            track_id: unit.track_id,
            timing: unit.timing,
            duration: None,
            is_sync: unit.is_sync,
            data: data.to_vec(),
        }));
        Ok(())
    }

    fn flush(&mut self, _out: &mut Vec<VideoNormalizerEvent>) -> Result<(), CoreError> {
        Ok(())
    }
}

impl Av1Normalizer {
    fn emit_configuration_if_ready(&mut self, out: &mut Vec<VideoNormalizerEvent>) {
        let Some(config) = &self.config else {
            return;
        };
        if self.configuration_emitted || config.width.is_none() || config.height.is_none() {
            return;
        }

        out.push(VideoNormalizerEvent::Configuration(VideoCodecConfig::Av1(
            config.clone(),
        )));
        self.configuration_emitted = true;
    }

    fn complete_configuration_from_temporal_unit(
        &mut self,
        data: &[u8],
        out: &mut Vec<VideoNormalizerEvent>,
    ) -> Result<(), CoreError> {
        if self.configuration_emitted {
            return Ok(());
        }

        let (width, height) = sequence_header_dimensions(data)?.ok_or_else(|| {
            invalid_config("AV1 temporal unit arrived before an AV1 sequence header.")
        })?;
        let config = self.config.as_mut().ok_or_else(|| {
            invalid_config("AV1 media sample arrived before AV1CodecConfigurationRecord.")
        })?;
        config.width = Some(width);
        config.height = Some(height);
        self.emit_configuration_if_ready(out);
        Ok(())
    }
}

const OBU_SEQUENCE_HEADER: u8 = 1;

fn sequence_header_dimensions(data: &[u8]) -> Result<Option<(u32, u32)>, CoreError> {
    let mut offset = 0;
    while offset < data.len() {
        let header = *data
            .get(offset)
            .ok_or_else(|| invalid_container("AV1 OBU header is truncated."))?;
        offset += 1;
        validate_obu_header(header)?;

        let obu_type = (header >> 3) & 0x0F;
        if header & 0x04 != 0 {
            let extension = *data.get(offset).ok_or_else(|| {
                invalid_container("AV1 OBU header declares a missing extension byte.")
            })?;
            if extension & 0x07 != 0 {
                return Err(invalid_container(
                    "AV1 OBU extension header has non-zero reserved bits.",
                ));
            }
            offset += 1;
        }

        let payload_length = if header & 0x02 != 0 {
            read_leb128(data, &mut offset)?
        } else if obu_type == OBU_SEQUENCE_HEADER {
            data.len() - offset
        } else {
            return Err(invalid_container(
                "AV1 OBU without a size field is unsupported before a sequence header.",
            ));
        };
        let payload_end = offset.checked_add(payload_length).ok_or_else(|| {
            invalid_container("AV1 OBU payload length overflows the input buffer.")
        })?;
        let payload = data
            .get(offset..payload_end)
            .ok_or_else(|| invalid_container("AV1 OBU payload is truncated."))?;

        if obu_type == OBU_SEQUENCE_HEADER {
            return parse_sequence_header_dimensions(payload).map(Some);
        }
        offset = payload_end;
    }
    Ok(None)
}

fn validate_obu_header(header: u8) -> Result<(), CoreError> {
    if header & 0x80 != 0 {
        return Err(invalid_container(
            "AV1 OBU header has a non-zero forbidden bit.",
        ));
    }
    if header & 0x01 != 0 {
        return Err(invalid_container(
            "AV1 OBU header has a non-zero reserved bit.",
        ));
    }
    Ok(())
}

fn read_leb128(data: &[u8], offset: &mut usize) -> Result<usize, CoreError> {
    let mut value = 0_u64;
    for index in 0..8 {
        let byte = *data
            .get(*offset)
            .ok_or_else(|| invalid_container("AV1 OBU size field is truncated."))?;
        *offset += 1;
        value |= u64::from(byte & 0x7F) << (index * 7);
        if byte & 0x80 == 0 {
            return usize::try_from(value)
                .map_err(|_| invalid_container("AV1 OBU size field exceeds usize."));
        }
    }
    Err(invalid_container("AV1 OBU size field exceeds eight bytes."))
}

fn parse_sequence_header_dimensions(data: &[u8]) -> Result<(u32, u32), CoreError> {
    let mut bits = BitReader::new(data);
    let _seq_profile = bits.read_bits(3)?;
    bits.read_bool()?;
    let reduced_still_picture_header = bits.read_bool()?;

    if reduced_still_picture_header {
        bits.read_bits(5)?;
    } else {
        let decoder_model_delay_bits = if bits.read_bool()? {
            bits.read_bits(32)?;
            bits.read_bits(32)?;
            if bits.read_bool()? {
                bits.read_uvlc()?;
            }
            if bits.read_bool()? {
                let buffer_delay_length_minus_1 = bits.read_bits(5)? as usize;
                bits.read_bits(32)?;
                bits.read_bits(5)?;
                bits.read_bits(5)?;
                Some(buffer_delay_length_minus_1 + 1)
            } else {
                None
            }
        } else {
            None
        };
        let initial_display_delay_present = bits.read_bool()?;
        let operating_points_count = bits.read_bits(5)? as usize + 1;
        for _ in 0..operating_points_count {
            bits.read_bits(12)?;
            let level = bits.read_bits(5)?;
            if level > 7 {
                bits.read_bool()?;
            }
            if let Some(delay_bits) = decoder_model_delay_bits
                && bits.read_bool()?
            {
                bits.read_bits(delay_bits)?;
                bits.read_bits(delay_bits)?;
                bits.read_bool()?;
            }
            if initial_display_delay_present && bits.read_bool()? {
                bits.read_bits(4)?;
            }
        }
    }

    let width_bits = bits.read_bits(4)? as usize + 1;
    let height_bits = bits.read_bits(4)? as usize + 1;
    let width = u32::try_from(bits.read_bits(width_bits)? + 1)
        .map_err(|_| invalid_config("AV1 sequence header width exceeds u32."))?;
    let height = u32::try_from(bits.read_bits(height_bits)? + 1)
        .map_err(|_| invalid_config("AV1 sequence header height exceeds u32."))?;
    Ok((width, height))
}

struct BitReader<'a> {
    data: &'a [u8],
    bit_offset: usize,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            bit_offset: 0,
        }
    }

    fn read_bool(&mut self) -> Result<bool, CoreError> {
        Ok(self.read_bits(1)? != 0)
    }

    fn read_bits(&mut self, count: usize) -> Result<u64, CoreError> {
        let end = self
            .bit_offset
            .checked_add(count)
            .ok_or_else(|| invalid_container("AV1 sequence header bit offset overflows."))?;
        if end > self.data.len().saturating_mul(8) {
            return Err(invalid_container("AV1 sequence header is truncated."));
        }

        let mut value = 0_u64;
        for _ in 0..count {
            let byte = self.data[self.bit_offset / 8];
            let shift = 7 - (self.bit_offset % 8);
            value = (value << 1) | u64::from((byte >> shift) & 1);
            self.bit_offset += 1;
        }
        Ok(value)
    }

    fn read_uvlc(&mut self) -> Result<u64, CoreError> {
        let mut leading_zero_bits = 0_usize;
        while !self.read_bool()? {
            leading_zero_bits += 1;
            if leading_zero_bits >= 32 {
                return Err(invalid_container(
                    "AV1 sequence header unsigned VLC is too wide.",
                ));
            }
        }
        if leading_zero_bits == 0 {
            return Ok(0);
        }

        let suffix = self.read_bits(leading_zero_bits)?;
        Ok(((1_u64 << leading_zero_bits) - 1) + suffix)
    }
}

fn validate_obu_temporal_unit(data: &[u8]) -> Result<(), CoreError> {
    let header = *data
        .first()
        .ok_or_else(|| invalid_container("AV1 temporal unit is empty."))?;
    validate_obu_header(header)?;
    if header & 0x04 != 0 {
        let extension = *data.get(1).ok_or_else(|| {
            invalid_container("AV1 OBU header declares a missing extension byte.")
        })?;
        if extension & 0x07 != 0 {
            return Err(invalid_container(
                "AV1 OBU extension header has non-zero reserved bits.",
            ));
        }
    }
    Ok(())
}

fn invalid_config(message: impl Into<String>) -> CoreError {
    CoreError::new(CoreErrorCode::InvalidCodecConfig, message)
}

fn invalid_container(message: impl Into<String>) -> CoreError {
    CoreError::new(CoreErrorCode::InvalidContainerData, message)
}

#[cfg(test)]
mod tests {
    use super::{Av1Config, Av1Normalizer};
    use crate::codec::VideoCodecConfig;
    use crate::codec::normalizer::{
        VideoAccessUnit, VideoAccessUnitNormalizer, VideoNormalizerEvent, VideoSampleData,
    };
    use crate::error::CoreErrorCode;
    use crate::sample::{EncodedSample, SampleTiming};
    use crate::track::TrackId;

    #[test]
    fn parses_av1_codec_configuration_record() {
        let config = Av1Config::from_av1c(&minimal_av1c()).unwrap();

        assert_eq!(config.codec_string, "av01.0.08M.08");
        assert_eq!(config.width, None);
        assert_eq!(config.height, None);
    }

    #[test]
    fn extracts_dimensions_from_sequence_header_config_obu() {
        let config = Av1Config::from_av1c(&av1c_with_sequence_header()).unwrap();

        assert_eq!(config.width, Some(64));
        assert_eq!(config.height, Some(64));
    }

    #[test]
    fn rejects_invalid_av1_codec_configuration_record() {
        let error = Av1Config::from_av1c(&[0x80, 0x08, 0x00, 0x00]).unwrap_err();

        assert_eq!(error.code, CoreErrorCode::InvalidCodecConfig);
    }

    #[test]
    fn normalizes_obu_temporal_unit_after_configuration() {
        let mut normalizer = Av1Normalizer::default();
        let mut events = Vec::new();
        normalizer
            .on_configuration(&av1c_with_sequence_header(), &mut events)
            .unwrap();

        events.clear();
        normalizer
            .push_access_unit(
                VideoAccessUnit {
                    track_id: TrackId::VIDEO,
                    timing: SampleTiming { dts: 10, pts: 10 },
                    is_sync: true,
                    data: VideoSampleData::ObuTemporalUnit(&[0x12, 0x00]),
                },
                &mut events,
            )
            .unwrap();

        assert!(matches!(
            events.as_slice(),
            [VideoNormalizerEvent::Sample(EncodedSample::Video {
                track_id,
                timing: SampleTiming { dts: 10, pts: 10 },
                is_sync: true,
                data,
                ..
            })] if *track_id == TrackId::VIDEO && *data == [0x12, 0x00]
        ));
    }

    #[test]
    fn defers_configuration_until_temporal_unit_contains_sequence_header() {
        let mut normalizer = Av1Normalizer::default();
        let mut events = Vec::new();
        normalizer
            .on_configuration(&minimal_av1c(), &mut events)
            .unwrap();

        assert!(events.is_empty());
        normalizer
            .push_access_unit(
                VideoAccessUnit {
                    track_id: TrackId::VIDEO,
                    timing: SampleTiming { dts: 10, pts: 10 },
                    is_sync: true,
                    data: VideoSampleData::ObuTemporalUnit(&sequence_header_obu()),
                },
                &mut events,
            )
            .unwrap();

        assert!(matches!(
            events.as_slice(),
            [
                VideoNormalizerEvent::Configuration(VideoCodecConfig::Av1(config)),
                VideoNormalizerEvent::Sample(_),
            ] if config.width == Some(64) && config.height == Some(64)
        ));
    }

    #[test]
    fn rejects_temporal_unit_before_configuration() {
        let mut normalizer = Av1Normalizer::default();
        let mut events = Vec::new();
        let error = normalizer
            .push_access_unit(
                VideoAccessUnit {
                    track_id: TrackId::VIDEO,
                    timing: SampleTiming { dts: 0, pts: 0 },
                    is_sync: false,
                    data: VideoSampleData::ObuTemporalUnit(&[0x12, 0x00]),
                },
                &mut events,
            )
            .unwrap_err();

        assert_eq!(error.code, CoreErrorCode::InvalidCodecConfig);
    }

    #[test]
    fn ignores_repeated_configuration_and_rejects_a_change() {
        let mut normalizer = Av1Normalizer::default();
        let mut events = Vec::new();
        let config = av1c_with_sequence_header();

        normalizer.on_configuration(&config, &mut events).unwrap();
        normalizer.on_configuration(&config, &mut events).unwrap();

        assert!(matches!(
            events.as_slice(),
            [VideoNormalizerEvent::Configuration(_)]
        ));

        let error = normalizer
            .on_configuration(&[0x81, 0x09, 0x00, 0x00], &mut events)
            .unwrap_err();

        assert_eq!(error.code, CoreErrorCode::InvalidCodecConfig);
    }

    fn minimal_av1c() -> Vec<u8> {
        vec![0x81, 0x08, 0x00, 0x00]
    }

    fn av1c_with_sequence_header() -> Vec<u8> {
        let mut av1c = vec![0x81, 0x00, 0x0C, 0x00];
        av1c.extend_from_slice(&sequence_header_obu());
        av1c
    }

    fn sequence_header_obu() -> [u8; 12] {
        [
            0x0A, 0x0A, 0x00, 0x00, 0x00, 0x02, 0xAF, 0xFF, 0x9B, 0x5F, 0x20, 0x08,
        ]
    }
}
