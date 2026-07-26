use crate::codec::aac::AacNormalizer;
use crate::codec::normalizer::{
    AudioAccessUnit, AudioFrameNormalizer, AudioNormalizerEvent, AudioSampleData,
};
use crate::codec::opus::OpusNormalizer;
use crate::error::{CoreError, CoreErrorCode};
use crate::sample::SampleTiming;
use crate::track::TrackId;

use super::types::*;

#[derive(Debug)]
enum FlvAudioNormalizer {
    Aac(AacNormalizer),
    Opus(OpusNormalizer),
}

impl FlvAudioNormalizer {
    fn new(codec: FlvAudioCodec) -> Self {
        match codec {
            FlvAudioCodec::Aac => Self::Aac(AacNormalizer::default()),
            FlvAudioCodec::Opus => Self::Opus(OpusNormalizer::default()),
        }
    }

    fn codec(&self) -> FlvAudioCodec {
        match self {
            Self::Aac(_) => FlvAudioCodec::Aac,
            Self::Opus(_) => FlvAudioCodec::Opus,
        }
    }

    fn on_configuration(
        &mut self,
        data: &[u8],
        out: &mut Vec<AudioNormalizerEvent>,
    ) -> Result<(), CoreError> {
        match self {
            Self::Aac(normalizer) => normalizer.on_configuration(data, out),
            Self::Opus(normalizer) => normalizer.on_configuration(data, out),
        }
    }

    fn push_access_unit(
        &mut self,
        unit: AudioAccessUnit<'_>,
        out: &mut Vec<AudioNormalizerEvent>,
    ) -> Result<(), CoreError> {
        match self {
            Self::Aac(normalizer) => normalizer.push_access_unit(unit, out),
            Self::Opus(normalizer) => normalizer.push_access_unit(unit, out),
        }
    }

    fn flush(&mut self, out: &mut Vec<AudioNormalizerEvent>) -> Result<(), CoreError> {
        match self {
            Self::Aac(normalizer) => normalizer.flush(out),
            Self::Opus(normalizer) => normalizer.flush(out),
        }
    }
}

#[derive(Debug, Default)]
pub(super) struct FlvAudioProcessor {
    normalizer: Option<FlvAudioNormalizer>,
}

impl FlvAudioProcessor {
    pub(super) fn process_tag(
        &mut self,
        header: FlvTagHeader,
        payload: &[u8],
        out: &mut Vec<AudioNormalizerEvent>,
    ) -> Result<(), CoreError> {
        if payload.is_empty() {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV audio tag is missing the codec header byte.",
            ));
        }

        match payload[0] >> 4 {
            SOUND_FORMAT_AAC => self.process_aac_tag(header, payload, out),
            SOUND_FORMAT_EX_AUDIO => self.process_enhanced_tag(header, payload, out),
            sound_format => Err(CoreError::new(
                CoreErrorCode::UnsupportedAudioCodec,
                format!("Unsupported FLV audio sound format {sound_format}."),
            )),
        }
    }

    pub(super) fn flush(&mut self, out: &mut Vec<AudioNormalizerEvent>) -> Result<(), CoreError> {
        if let Some(normalizer) = &mut self.normalizer {
            normalizer.flush(out)?;
        }
        Ok(())
    }

    fn process_aac_tag(
        &mut self,
        header: FlvTagHeader,
        payload: &[u8],
        out: &mut Vec<AudioNormalizerEvent>,
    ) -> Result<(), CoreError> {
        if payload.len() < 2 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV AAC audio tag is too short.",
            ));
        }

        match payload[1] {
            AAC_PACKET_TYPE_SEQUENCE_HEADER => self
                .normalizer_mut(FlvAudioCodec::Aac)?
                .on_configuration(&payload[2..], out),
            AAC_PACKET_TYPE_RAW => self.normalizer_mut(FlvAudioCodec::Aac)?.push_access_unit(
                AudioAccessUnit {
                    track_id: TrackId::AUDIO,
                    timing: SampleTiming {
                        dts: header.timestamp_ms,
                        pts: header.timestamp_ms,
                    },
                    input_timescale: FLV_TIMESCALE,
                    data: AudioSampleData::RawAac(&payload[2..]),
                },
                out,
            ),
            other => Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                format!("Unsupported AAC packet type {other}."),
            )),
        }
    }

    fn process_enhanced_tag(
        &mut self,
        header: FlvTagHeader,
        payload: &[u8],
        out: &mut Vec<AudioNormalizerEvent>,
    ) -> Result<(), CoreError> {
        if payload.len() < 5 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "Enhanced FLV audio tag is too short for a FourCC.",
            ));
        }

        let packet_type = payload[0] & 0b0000_1111;
        let codec = FlvAudioCodec::from_fourcc(&payload[1..5])?;
        match packet_type {
            AUDIO_PACKET_TYPE_SEQUENCE_START => self
                .normalizer_mut(codec)?
                .on_configuration(&payload[5..], out),
            AUDIO_PACKET_TYPE_CODED_FRAMES => self.normalizer_mut(codec)?.push_access_unit(
                AudioAccessUnit {
                    track_id: TrackId::AUDIO,
                    timing: SampleTiming {
                        dts: header.timestamp_ms,
                        pts: header.timestamp_ms,
                    },
                    input_timescale: FLV_TIMESCALE,
                    data: AudioSampleData::RawOpus(&payload[5..]),
                },
                out,
            ),
            AUDIO_PACKET_TYPE_SEQUENCE_END => Ok(()),
            AUDIO_PACKET_TYPE_MULTICHANNEL_CONFIG => Err(CoreError::new(
                CoreErrorCode::UnsupportedAudioCodec,
                "Enhanced FLV Opus multichannel configuration is not supported.",
            )),
            AUDIO_PACKET_TYPE_MULTITRACK => Err(CoreError::new(
                CoreErrorCode::UnsupportedAudioCodec,
                "Enhanced FLV Opus multitrack audio is not supported.",
            )),
            AUDIO_PACKET_TYPE_MOD_EX => Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "Enhanced FLV AudioPacketType.ModEx is not supported.",
            )),
            other => Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                format!("Unsupported Enhanced FLV audio packet type {other}."),
            )),
        }
    }

    fn normalizer_mut(
        &mut self,
        codec: FlvAudioCodec,
    ) -> Result<&mut FlvAudioNormalizer, CoreError> {
        if let Some(normalizer) = &self.normalizer
            && normalizer.codec() != codec
        {
            return Err(CoreError::new(
                CoreErrorCode::UnsupportedAudioCodec,
                "FLV stream changes audio codec after audio initialization.",
            ));
        }
        Ok(self
            .normalizer
            .get_or_insert_with(|| FlvAudioNormalizer::new(codec)))
    }
}
