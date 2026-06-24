use crate::error::{CoreError, CoreErrorCode};
use crate::probe::AudioCodecKind;

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct AudioConfig {
    pub codec: AudioCodecKind,
    pub codec_string: String,
    pub object_type: u8,
    pub sample_rate: u32,
    pub channel_count: u8,
    pub audio_specific_config: Vec<u8>,
}

pub fn parse_audio_specific_config(data: &[u8]) -> Result<AudioConfig, CoreError> {
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

    Ok(AudioConfig {
        codec: AudioCodecKind::Aac,
        codec_string: "mp4a.40.2".to_string(),
        object_type,
        sample_rate,
        channel_count,
        audio_specific_config: data.to_vec(),
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
