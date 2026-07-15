use crate::codec::AudioCodecConfig;
use crate::codec::normalizer::{
    AudioAccessUnit, AudioFrameNormalizer, AudioNormalizerEvent, AudioSampleData,
};
use crate::error::{CoreError, CoreErrorCode};
use crate::sample::EncodedSample;

pub const OPUS_SAMPLE_RATE: u32 = 48_000;

const OPUS_HEAD_MAGIC: &[u8; 8] = b"OpusHead";
const OPUS_HEAD_LEN: usize = 19;
const OPUS_VERSION: u8 = 1;
const MAX_PACKET_DURATION_SAMPLES: u32 = OPUS_SAMPLE_RATE * 120 / 1_000;

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct OpusConfig {
    pub codec_string: String,
    pub channel_count: u8,
    pub pre_skip: u16,
    pub input_sample_rate: u32,
    pub output_gain: i16,
}

impl OpusConfig {
    pub(crate) fn from_opus_head(data: &[u8]) -> Result<Self, CoreError> {
        if data.len() < OPUS_HEAD_LEN {
            return Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "OpusHead is shorter than its fixed header.",
            ));
        }
        if data.len() > OPUS_HEAD_LEN {
            return Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "OpusHead with mapping family 0 must not contain trailing data.",
            ));
        }
        if &data[..OPUS_HEAD_MAGIC.len()] != OPUS_HEAD_MAGIC {
            return Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "Opus sequence header is missing the OpusHead signature.",
            ));
        }
        if data[8] != OPUS_VERSION {
            return Err(CoreError::new(
                CoreErrorCode::UnsupportedAudioCodec,
                format!("Unsupported OpusHead version {}.", data[8]),
            ));
        }

        let channel_count = data[9];
        if !(1..=2).contains(&channel_count) {
            return Err(CoreError::new(
                CoreErrorCode::UnsupportedAudioCodec,
                format!(
                    "Unsupported Opus channel count {channel_count}; only mono and stereo are supported."
                ),
            ));
        }
        if data[18] != 0 {
            return Err(CoreError::new(
                CoreErrorCode::UnsupportedAudioCodec,
                format!("Unsupported Opus channel mapping family {}.", data[18]),
            ));
        }

        Ok(Self {
            codec_string: "opus".to_string(),
            channel_count,
            pre_skip: u16::from_le_bytes([data[10], data[11]]),
            input_sample_rate: u32::from_le_bytes([data[12], data[13], data[14], data[15]]),
            output_gain: i16::from_le_bytes([data[16], data[17]]),
        })
    }
}

#[derive(Debug, Default)]
pub(crate) struct OpusNormalizer {
    config: Option<OpusConfig>,
}

impl AudioFrameNormalizer for OpusNormalizer {
    fn on_configuration(
        &mut self,
        data: &[u8],
        out: &mut Vec<AudioNormalizerEvent>,
    ) -> Result<(), CoreError> {
        let config = OpusConfig::from_opus_head(data)?;
        if let Some(previous) = &self.config {
            if previous == &config {
                return Ok(());
            }
            return Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "Opus configuration changes after audio initialization are not supported.",
            ));
        }

        self.config = Some(config.clone());
        out.push(AudioNormalizerEvent::Configuration(AudioCodecConfig::Opus(
            config,
        )));
        Ok(())
    }

    fn push_access_unit(
        &mut self,
        unit: AudioAccessUnit<'_>,
        out: &mut Vec<AudioNormalizerEvent>,
    ) -> Result<(), CoreError> {
        let data = match unit.data {
            AudioSampleData::RawOpus(data) => data,
            _ => {
                return Err(CoreError::new(
                    CoreErrorCode::InvalidCodecConfig,
                    "Opus normalizer received a non-Opus audio access unit.",
                ));
            }
        };
        self.config.as_ref().ok_or_else(|| {
            CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                "Opus media sample arrived before OpusHead.",
            )
        })?;

        out.push(AudioNormalizerEvent::Sample(EncodedSample::Audio {
            track_id: unit.track_id,
            timing: unit.timing,
            duration: opus_packet_duration(data)?,
            data: data.to_vec(),
        }));
        Ok(())
    }

    fn flush(&mut self, _out: &mut Vec<AudioNormalizerEvent>) -> Result<(), CoreError> {
        Ok(())
    }
}

fn opus_packet_duration(data: &[u8]) -> Result<u32, CoreError> {
    let toc = *data.first().ok_or_else(|| {
        CoreError::new(
            CoreErrorCode::InvalidContainerData,
            "Opus coded frame is empty.",
        )
    })?;
    let configuration = toc >> 3;
    let frame_duration = match configuration {
        0..=11 => 480_u32 << (configuration & 0b11),
        12..=15 => 480_u32 << (configuration & 0b1),
        _ => 120_u32 << (configuration & 0b11),
    };
    let frame_count = match toc & 0b11 {
        0 => 1,
        1 | 2 => 2,
        3 => {
            let count = data.get(1).copied().ok_or_else(|| {
                CoreError::new(
                    CoreErrorCode::InvalidContainerData,
                    "Opus code-3 packet is missing its frame count byte.",
                )
            })? & 0b0011_1111;
            if count == 0 {
                return Err(CoreError::new(
                    CoreErrorCode::InvalidContainerData,
                    "Opus code-3 packet declares zero frames.",
                ));
            }
            u32::from(count)
        }
        _ => unreachable!("two-bit Opus frame count is exhaustive"),
    };
    let duration = frame_duration.checked_mul(frame_count).ok_or_else(|| {
        CoreError::new(
            CoreErrorCode::InvalidCodecConfig,
            "Opus packet duration overflows.",
        )
    })?;
    if duration > MAX_PACKET_DURATION_SAMPLES {
        return Err(CoreError::new(
            CoreErrorCode::InvalidCodecConfig,
            "Opus packet duration exceeds 120 milliseconds.",
        ));
    }
    Ok(duration)
}

#[cfg(test)]
mod tests {
    use super::{OpusConfig, OpusNormalizer};
    use crate::codec::normalizer::{
        AudioAccessUnit, AudioFrameNormalizer, AudioNormalizerEvent, AudioSampleData,
    };
    use crate::error::CoreErrorCode;
    use crate::sample::{EncodedSample, SampleTiming};
    use crate::track::TrackId;

    const STEREO_OPUS_HEAD: [u8; 19] = [
        b'O', b'p', b'u', b's', b'H', b'e', b'a', b'd', 1, 2, 0x38, 0x01, 0x80, 0xBB, 0, 0, 0, 0, 0,
    ];

    #[test]
    fn parses_stereo_opus_head() {
        let config = OpusConfig::from_opus_head(&STEREO_OPUS_HEAD).unwrap();

        assert_eq!(config.codec_string, "opus");
        assert_eq!(config.channel_count, 2);
        assert_eq!(config.pre_skip, 312);
        assert_eq!(config.input_sample_rate, 48_000);
        assert_eq!(config.output_gain, 0);
    }

    #[test]
    fn normalizes_twenty_millisecond_opus_packet() {
        let mut normalizer = OpusNormalizer::default();
        let mut events = Vec::new();

        normalizer
            .on_configuration(&STEREO_OPUS_HEAD, &mut events)
            .unwrap();
        events.clear();
        normalizer
            .push_access_unit(
                AudioAccessUnit {
                    track_id: TrackId::AUDIO,
                    timing: SampleTiming { dts: 20, pts: 20 },
                    input_timescale: 1_000,
                    data: AudioSampleData::RawOpus(&[0xF8, 0xFF, 0xFE]),
                },
                &mut events,
            )
            .unwrap();

        assert!(matches!(
            events.as_slice(),
            [AudioNormalizerEvent::Sample(EncodedSample::Audio {
                track_id,
                timing: SampleTiming { dts: 20, pts: 20 },
                duration: 960,
                data,
            })] if *track_id == TrackId::AUDIO && *data == [0xF8, 0xFF, 0xFE]
        ));
    }

    #[test]
    fn rejects_packet_duration_over_one_hundred_twenty_milliseconds() {
        let mut normalizer = OpusNormalizer::default();
        let mut events = Vec::new();
        normalizer
            .on_configuration(&STEREO_OPUS_HEAD, &mut events)
            .unwrap();

        let error = normalizer
            .push_access_unit(
                AudioAccessUnit {
                    track_id: TrackId::AUDIO,
                    timing: SampleTiming { dts: 0, pts: 0 },
                    input_timescale: 1_000,
                    data: AudioSampleData::RawOpus(&[0x1B, 3]),
                },
                &mut events,
            )
            .unwrap_err();

        assert_eq!(error.code, CoreErrorCode::InvalidCodecConfig);
    }

    #[test]
    fn rejects_nonzero_channel_mapping_family() {
        let mut header = STEREO_OPUS_HEAD;
        header[18] = 1;

        let error = OpusConfig::from_opus_head(&header).unwrap_err();

        assert_eq!(error.code, CoreErrorCode::UnsupportedAudioCodec);
    }
}
