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

        Ok(Self {
            codec_string: format!("av01.{seq_profile}.{seq_level_idx_0:02}{tier}.{bit_depth:02}"),
            width: None,
            height: None,
            av1c: data.to_vec(),
        })
    }
}

#[derive(Debug, Default)]
pub(crate) struct Av1Normalizer {
    config: Option<Av1Config>,
}

impl VideoAccessUnitNormalizer for Av1Normalizer {
    fn on_configuration(
        &mut self,
        data: &[u8],
        out: &mut Vec<VideoNormalizerEvent>,
    ) -> Result<(), CoreError> {
        let config = Av1Config::from_av1c(data)?;
        self.config = Some(config.clone());
        out.push(VideoNormalizerEvent::Configuration(VideoCodecConfig::Av1(
            config,
        )));
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

fn validate_obu_temporal_unit(data: &[u8]) -> Result<(), CoreError> {
    let header = *data
        .first()
        .ok_or_else(|| invalid_container("AV1 temporal unit is empty."))?;
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
    fn rejects_invalid_av1_codec_configuration_record() {
        let error = Av1Config::from_av1c(&[0x80, 0x08, 0x00, 0x00]).unwrap_err();

        assert_eq!(error.code, CoreErrorCode::InvalidCodecConfig);
    }

    #[test]
    fn normalizes_obu_temporal_unit_after_configuration() {
        let mut normalizer = Av1Normalizer::default();
        let mut events = Vec::new();
        normalizer
            .on_configuration(&minimal_av1c(), &mut events)
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

    fn minimal_av1c() -> Vec<u8> {
        vec![0x81, 0x08, 0x00, 0x00]
    }
}
