use crate::codec::AudioCodecConfig;
use crate::codec::normalizer::{
    AudioAccessUnit, AudioFrameNormalizer, AudioNormalizerEvent, AudioSampleData,
    accept_initial_configuration,
};
use crate::error::{CoreError, CoreErrorCode};
use crate::sample::{EncodedSample, SampleTiming};

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct AacConfig {
    pub codec_string: String,
    pub object_type: u8,
    pub sample_rate: u32,
    pub channel_count: u8,
    pub audio_specific_config: Vec<u8>,
}

impl AacConfig {
    pub(crate) fn from_audio_specific_config(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() < 2 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "AAC AudioSpecificConfig is too short.",
            ));
        }

        let object_type = data[0] >> 3;
        if object_type != 2 {
            return Err(CoreError::new(
                CoreErrorCode::UnsupportedAudioCodec,
                "Only AAC-LC AudioSpecificConfig is supported.",
            ));
        }

        let sampling_frequency_index = ((data[0] & 0b0000_0111) << 1) | (data[1] >> 7);
        let sample_rate = sample_rate_from_index(sampling_frequency_index).ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "AAC AudioSpecificConfig has an unsupported sampling frequency index.",
            )
        })?;

        let channel_count = (data[1] >> 3) & 0b0000_1111;
        if channel_count == 0 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "AAC AudioSpecificConfig uses unsupported program-config channel layout.",
            ));
        }
        if channel_count > 7 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "AAC AudioSpecificConfig uses a reserved channel configuration.",
            ));
        }
        if data[1] & 0b0000_0100 != 0 {
            return Err(CoreError::new(
                CoreErrorCode::UnsupportedAudioCodec,
                "AAC-LC AudioSpecificConfig with a 960-sample frame length is not supported.",
            ));
        }

        Ok(Self {
            codec_string: "mp4a.40.2".to_string(),
            object_type,
            sample_rate,
            channel_count,
            audio_specific_config: data.to_vec(),
        })
    }
}

#[derive(Debug, Default)]
pub(crate) struct AacNormalizer {
    config: Option<AacConfig>,
}

impl AudioFrameNormalizer for AacNormalizer {
    fn on_configuration(
        &mut self,
        data: &[u8],
        out: &mut Vec<AudioNormalizerEvent>,
    ) -> Result<(), CoreError> {
        let config = AacConfig::from_audio_specific_config(data)?;
        if accept_initial_configuration(&mut self.config, config.clone(), "AAC")? {
            out.push(AudioNormalizerEvent::Configuration(AudioCodecConfig::Aac(
                config,
            )));
        }
        Ok(())
    }

    fn push_access_unit(
        &mut self,
        unit: AudioAccessUnit<'_>,
        out: &mut Vec<AudioNormalizerEvent>,
    ) -> Result<(), CoreError> {
        match unit.data {
            AudioSampleData::RawAac(data) => {
                self.config.as_ref().ok_or_else(|| {
                    CoreError::new(
                        CoreErrorCode::InvalidCodecConfig,
                        "AAC media sample arrived before AudioSpecificConfig.",
                    )
                })?;
                out.push(AudioNormalizerEvent::Sample(EncodedSample::Audio {
                    track_id: unit.track_id,
                    timing: unit.timing,
                    duration: 1024,
                    data: data.to_vec(),
                }));
                Ok(())
            }
            AudioSampleData::RawOpus(_) => Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "AAC normalizer received a non-AAC audio access unit.",
            )),
            AudioSampleData::Adts(data) => self.normalize_adts_access_unit(
                unit.track_id,
                unit.timing,
                unit.input_timescale,
                data,
                out,
            ),
        }
    }

    fn flush(&mut self, _out: &mut Vec<AudioNormalizerEvent>) -> Result<(), CoreError> {
        Ok(())
    }
}

impl AacNormalizer {
    fn normalize_adts_access_unit(
        &mut self,
        track_id: crate::track::TrackId,
        timing: SampleTiming,
        input_timescale: u32,
        data: &[u8],
        out: &mut Vec<AudioNormalizerEvent>,
    ) -> Result<(), CoreError> {
        if input_timescale == 0 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidTimestamp,
                "AAC ADTS access unit has a zero input timescale.",
            ));
        }

        let composition_offset = timing.pts.checked_sub(timing.dts).ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::InvalidTimestamp,
                "AAC ADTS sample composition offset overflows.",
            )
        })?;
        let mut offset = 0;
        let mut sample_offset = 0_u64;
        while offset < data.len() {
            let header = AdtsHeader::parse(data, offset)?;
            if accept_initial_configuration(&mut self.config, header.config.clone(), "AAC")? {
                out.push(AudioNormalizerEvent::Configuration(AudioCodecConfig::Aac(
                    header.config.clone(),
                )));
            }

            let timestamp_offset =
                samples_to_ticks(sample_offset, header.config.sample_rate, input_timescale)?;
            let dts = timing.dts.checked_add(timestamp_offset).ok_or_else(|| {
                CoreError::new(
                    CoreErrorCode::InvalidTimestamp,
                    "AAC ADTS sample DTS overflows.",
                )
            })?;
            let pts = dts.checked_add(composition_offset).ok_or_else(|| {
                CoreError::new(
                    CoreErrorCode::InvalidTimestamp,
                    "AAC ADTS sample PTS overflows.",
                )
            })?;
            out.push(AudioNormalizerEvent::Sample(EncodedSample::Audio {
                track_id,
                timing: SampleTiming { dts, pts },
                duration: 1024,
                data: data[header.payload_start..header.frame_end].to_vec(),
            }));
            sample_offset = sample_offset.checked_add(1024).ok_or_else(|| {
                CoreError::new(
                    CoreErrorCode::InvalidTimestamp,
                    "AAC ADTS sample count overflows.",
                )
            })?;
            offset = header.frame_end;
        }

        if offset == 0 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "AAC ADTS access unit is empty.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug)]
struct AdtsHeader {
    config: AacConfig,
    payload_start: usize,
    frame_end: usize,
}

impl AdtsHeader {
    fn parse(data: &[u8], offset: usize) -> Result<Self, CoreError> {
        let fixed_header = data.get(offset..offset + 7).ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "AAC ADTS frame is shorter than its fixed header.",
            )
        })?;
        if fixed_header[0] != 0xFF || fixed_header[1] & 0xF0 != 0xF0 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "AAC ADTS frame is missing its sync word.",
            ));
        }

        let protection_absent = fixed_header[1] & 1 != 0;
        let header_length = if protection_absent { 7 } else { 9 };
        data.get(offset..offset + header_length).ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "AAC ADTS frame is shorter than its declared header.",
            )
        })?;
        let raw_data_blocks = fixed_header[6] & 0b11;
        if raw_data_blocks != 0 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "AAC ADTS frames with multiple raw data blocks are not supported.",
            ));
        }

        let object_type = ((fixed_header[2] >> 6) & 0b11) + 1;
        let sampling_frequency_index = (fixed_header[2] >> 2) & 0b1111;
        let channel_count = ((fixed_header[2] & 1) << 2) | (fixed_header[3] >> 6);
        let audio_specific_config = [
            (object_type << 3) | (sampling_frequency_index >> 1),
            ((sampling_frequency_index & 1) << 7) | (channel_count << 3),
        ];
        let config = AacConfig::from_audio_specific_config(&audio_specific_config)?;

        let frame_length = ((usize::from(fixed_header[3] & 0b11)) << 11)
            | (usize::from(fixed_header[4]) << 3)
            | usize::from(fixed_header[5] >> 5);
        if frame_length < header_length {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "AAC ADTS frame length is smaller than its header.",
            ));
        }
        let frame_end = offset.checked_add(frame_length).ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "AAC ADTS frame length overflows.",
            )
        })?;
        if frame_end > data.len() {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "AAC ADTS frame is truncated.",
            ));
        }

        Ok(Self {
            config,
            payload_start: offset + header_length,
            frame_end,
        })
    }
}

fn samples_to_ticks(
    sample_count: u64,
    sample_rate: u32,
    input_timescale: u32,
) -> Result<i64, CoreError> {
    let ticks = (u128::from(sample_count) * u128::from(input_timescale)) / u128::from(sample_rate);
    i64::try_from(ticks).map_err(|_| {
        CoreError::new(
            CoreErrorCode::InvalidTimestamp,
            "AAC ADTS sample timestamp exceeds the supported range.",
        )
    })
}

fn sample_rate_from_index(index: u8) -> Option<u32> {
    match index {
        0 => Some(96_000),
        1 => Some(88_200),
        2 => Some(64_000),
        3 => Some(48_000),
        4 => Some(44_100),
        5 => Some(32_000),
        6 => Some(24_000),
        7 => Some(22_050),
        8 => Some(16_000),
        9 => Some(12_000),
        10 => Some(11_025),
        11 => Some(8_000),
        12 => Some(7_350),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{AacConfig, AacNormalizer};
    use crate::codec::normalizer::{
        AudioAccessUnit, AudioFrameNormalizer, AudioNormalizerEvent, AudioSampleData,
    };
    use crate::error::CoreErrorCode;
    use crate::sample::{EncodedSample, SampleTiming};
    use crate::track::TrackId;

    #[test]
    fn normalizes_raw_aac_access_unit_after_configuration() {
        let mut normalizer = AacNormalizer::default();
        let mut events = Vec::new();

        normalizer
            .on_configuration(&[0x12, 0x10], &mut events)
            .unwrap();
        assert!(matches!(
            events.as_slice(),
            [AudioNormalizerEvent::Configuration(_)]
        ));

        events.clear();
        normalizer
            .push_access_unit(
                AudioAccessUnit {
                    track_id: TrackId::AUDIO,
                    timing: SampleTiming { dts: 20, pts: 20 },
                    input_timescale: 1_000,
                    data: AudioSampleData::RawAac(&[0x21, 0x22]),
                },
                &mut events,
            )
            .unwrap();

        assert!(matches!(
            events.as_slice(),
            [AudioNormalizerEvent::Sample(EncodedSample::Audio {
                track_id,
                timing: SampleTiming { dts: 20, pts: 20 },
                duration: 1024,
                data,
            })] if *track_id == TrackId::AUDIO && *data == [0x21, 0x22]
        ));
    }

    #[test]
    fn rejects_raw_aac_access_unit_before_configuration() {
        let mut normalizer = AacNormalizer::default();
        let mut events = Vec::new();

        let error = normalizer
            .push_access_unit(
                AudioAccessUnit {
                    track_id: TrackId::AUDIO,
                    timing: SampleTiming { dts: 0, pts: 0 },
                    input_timescale: 1_000,
                    data: AudioSampleData::RawAac(&[0x21]),
                },
                &mut events,
            )
            .unwrap_err();

        assert_eq!(error.code, CoreErrorCode::InvalidCodecConfig);
    }

    #[test]
    fn ignores_repeated_audio_specific_config_and_rejects_a_change() {
        let mut normalizer = AacNormalizer::default();
        let mut events = Vec::new();

        normalizer
            .on_configuration(&[0x12, 0x10], &mut events)
            .unwrap();
        normalizer
            .on_configuration(&[0x12, 0x10], &mut events)
            .unwrap();

        assert!(matches!(
            events.as_slice(),
            [AudioNormalizerEvent::Configuration(_)]
        ));

        let error = normalizer
            .on_configuration(&[0x12, 0x08], &mut events)
            .unwrap_err();

        assert_eq!(error.code, CoreErrorCode::InvalidCodecConfig);
    }

    #[test]
    fn rejects_reserved_channel_configuration() {
        let error = AacConfig::from_audio_specific_config(&[0x12, 0x40]).unwrap_err();

        assert_eq!(error.code, CoreErrorCode::InvalidCodecConfig);
    }

    #[test]
    fn rejects_nine_hundred_sixty_sample_frame_length() {
        let error = AacConfig::from_audio_specific_config(&[0x12, 0x14]).unwrap_err();

        assert_eq!(error.code, CoreErrorCode::UnsupportedAudioCodec);
    }

    #[test]
    fn normalizes_multiple_adts_frames_and_derives_configuration() {
        let mut normalizer = AacNormalizer::default();
        let mut events = Vec::new();
        let mut access_unit = aac_lc_adts_frame(&[0x21, 0x22]);
        access_unit.extend_from_slice(&aac_lc_adts_frame(&[0x23]));

        normalizer
            .push_access_unit(
                AudioAccessUnit {
                    track_id: TrackId::AUDIO,
                    timing: SampleTiming {
                        dts: 90_000,
                        pts: 90_000,
                    },
                    input_timescale: 90_000,
                    data: AudioSampleData::Adts(&access_unit),
                },
                &mut events,
            )
            .unwrap();

        assert!(matches!(
            events.as_slice(),
            [
                AudioNormalizerEvent::Configuration(_),
                AudioNormalizerEvent::Sample(EncodedSample::Audio {
                    timing: SampleTiming {
                        dts: 90_000,
                        pts: 90_000,
                    },
                    duration: 1024,
                    data: first_data,
                    ..
                }),
                AudioNormalizerEvent::Sample(EncodedSample::Audio {
                    timing: SampleTiming {
                        dts: 92_089,
                        pts: 92_089,
                    },
                    duration: 1024,
                    data: second_data,
                    ..
                }),
            ] if *first_data == [0x21, 0x22] && *second_data == [0x23]
        ));
    }

    #[test]
    fn rejects_truncated_adts_frame() {
        let mut normalizer = AacNormalizer::default();
        let mut events = Vec::new();
        let mut access_unit = aac_lc_adts_frame(&[0x21, 0x22]);
        access_unit.pop();

        let error = normalizer
            .push_access_unit(
                AudioAccessUnit {
                    track_id: TrackId::AUDIO,
                    timing: SampleTiming { dts: 0, pts: 0 },
                    input_timescale: 90_000,
                    data: AudioSampleData::Adts(&access_unit),
                },
                &mut events,
            )
            .unwrap_err();

        assert_eq!(error.code, CoreErrorCode::InvalidContainerData);
    }

    fn aac_lc_adts_frame(payload: &[u8]) -> Vec<u8> {
        let frame_length = 7 + payload.len();
        let mut frame = vec![
            0xFF,
            0xF1,
            0x50,
            0x80 | (((frame_length >> 11) & 0b11) as u8),
            ((frame_length >> 3) & 0xFF) as u8,
            (((frame_length & 0b111) << 5) as u8) | 0x1F,
            0xFC,
        ];
        frame.extend_from_slice(payload);
        frame
    }
}
