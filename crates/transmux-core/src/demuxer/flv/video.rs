use crate::codec::av1::Av1Normalizer;
use crate::codec::avc::AvcNormalizer;
use crate::codec::hevc::HevcNormalizer;
use crate::codec::normalizer::{
    VideoAccessUnit, VideoAccessUnitNormalizer, VideoNormalizerEvent, VideoSampleData,
};
use crate::error::{CoreError, CoreErrorCode};
use crate::event::CoreWarning;
use crate::sample::SampleTiming;
use crate::track::TrackId;

use super::types::*;

#[derive(Debug)]
enum FlvVideoNormalizer {
    Avc(AvcNormalizer),
    Hevc(HevcNormalizer),
    Av1(Av1Normalizer),
}

impl FlvVideoNormalizer {
    fn new(codec: FlvVideoCodec) -> Self {
        match codec {
            FlvVideoCodec::Avc => Self::Avc(AvcNormalizer::default()),
            FlvVideoCodec::Hevc => Self::Hevc(HevcNormalizer::default()),
            FlvVideoCodec::Av1 => Self::Av1(Av1Normalizer::default()),
        }
    }

    fn codec(&self) -> FlvVideoCodec {
        match self {
            Self::Avc(_) => FlvVideoCodec::Avc,
            Self::Hevc(_) => FlvVideoCodec::Hevc,
            Self::Av1(_) => FlvVideoCodec::Av1,
        }
    }

    fn on_configuration(
        &mut self,
        data: &[u8],
        out: &mut Vec<VideoNormalizerEvent>,
    ) -> Result<(), CoreError> {
        match self {
            Self::Avc(normalizer) => normalizer.on_configuration(data, out),
            Self::Hevc(normalizer) => normalizer.on_configuration(data, out),
            Self::Av1(normalizer) => normalizer.on_configuration(data, out),
        }
    }

    fn push_access_unit(
        &mut self,
        unit: VideoAccessUnit<'_>,
        out: &mut Vec<VideoNormalizerEvent>,
    ) -> Result<(), CoreError> {
        match self {
            Self::Avc(normalizer) => normalizer.push_access_unit(unit, out),
            Self::Hevc(normalizer) => normalizer.push_access_unit(unit, out),
            Self::Av1(normalizer) => normalizer.push_access_unit(unit, out),
        }
    }

    fn flush(&mut self, out: &mut Vec<VideoNormalizerEvent>) -> Result<(), CoreError> {
        match self {
            Self::Avc(normalizer) => normalizer.flush(out),
            Self::Hevc(normalizer) => normalizer.flush(out),
            Self::Av1(normalizer) => normalizer.flush(out),
        }
    }
}

#[derive(Debug)]
pub(super) enum FlvVideoEvent {
    Normalizer(VideoNormalizerEvent),
    Warning(CoreWarning),
}

#[derive(Debug, Default)]
pub(super) struct FlvVideoProcessor {
    normalizer: Option<FlvVideoNormalizer>,
}

impl FlvVideoProcessor {
    pub(super) fn process_tag(
        &mut self,
        header: FlvTagHeader,
        payload: &[u8],
        out: &mut Vec<FlvVideoEvent>,
    ) -> Result<(), CoreError> {
        if payload.is_empty() {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV video tag is missing the codec header byte.",
            ));
        }

        if payload[0] & VIDEO_EX_HEADER_FLAG != 0 {
            return self.process_enhanced_tag(header, payload, out);
        }

        self.process_legacy_tag(header, payload, out)
    }

    pub(super) fn flush(&mut self, out: &mut Vec<FlvVideoEvent>) -> Result<(), CoreError> {
        if let Some(normalizer) = &mut self.normalizer {
            let mut events = Vec::new();
            normalizer.flush(&mut events)?;
            out.extend(events.into_iter().map(FlvVideoEvent::Normalizer));
        }
        Ok(())
    }

    fn process_legacy_tag(
        &mut self,
        header: FlvTagHeader,
        payload: &[u8],
        out: &mut Vec<FlvVideoEvent>,
    ) -> Result<(), CoreError> {
        let frame_type = payload[0] >> 4;
        let codec_id = payload[0] & 0b0000_1111;
        if codec_id != VIDEO_CODEC_ID_AVC {
            return Err(CoreError::new(
                CoreErrorCode::UnsupportedVideoCodec,
                format!("Unsupported FLV video codec id {codec_id}."),
            ));
        }

        if payload.len() < 5 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "FLV AVC video tag is too short.",
            ));
        }

        let packet_type = payload[1];
        let dts_ms = header.timestamp_ms;
        let pts_ms = dts_ms + i64::from(read_i24(&payload[2..5]));

        match packet_type {
            AVC_PACKET_TYPE_SEQUENCE_HEADER => {
                self.push_configuration(FlvVideoCodec::Avc, &payload[5..], out)
            }
            AVC_PACKET_TYPE_NALU => self.push_access_unit(
                FlvVideoCodec::Avc,
                VideoAccessUnit {
                    track_id: TrackId::VIDEO,
                    timing: SampleTiming {
                        dts: dts_ms,
                        pts: pts_ms,
                    },
                    is_sync: frame_type == 1,
                    data: VideoSampleData::LengthPrefixedNalus(&payload[5..]),
                },
                out,
            ),
            AVC_PACKET_TYPE_END_OF_SEQUENCE => Ok(()),
            other => Err(CoreError::new(
                CoreErrorCode::InvalidCodecConfig,
                format!("Unsupported AVC packet type {other}."),
            )),
        }
    }

    fn process_enhanced_tag(
        &mut self,
        header: FlvTagHeader,
        payload: &[u8],
        out: &mut Vec<FlvVideoEvent>,
    ) -> Result<(), CoreError> {
        if payload.len() < 5 {
            return Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "Enhanced FLV video tag is too short for a FourCC.",
            ));
        }

        let packet_type = payload[0] & VIDEO_PACKET_TYPE_MASK;
        let codec = FlvVideoCodec::from_fourcc(&payload[1..5])?;
        let frame_type = (payload[0] & VIDEO_ENHANCED_FRAME_TYPE_MASK) >> 4;
        let dts_ms = header.timestamp_ms;

        match packet_type {
            VIDEO_PACKET_TYPE_SEQUENCE_START => {
                let configuration = &payload[5..];
                if codec == FlvVideoCodec::Av1 && configuration.is_empty() {
                    // FFmpeg may emit this before the encoder has produced av1C extradata.
                    out.push(FlvVideoEvent::Warning(CoreWarning::new(
                        "RIVMUX_FLV_ENHANCED_AV1_EMPTY_SEQUENCE_START_SKIPPED",
                        "Skipping an empty Enhanced FLV AV1 sequence-start tag.",
                    )));
                    Ok(())
                } else {
                    self.push_configuration(codec, configuration, out)
                }
            }
            VIDEO_PACKET_TYPE_CODED_FRAMES => {
                let (pts_ms, data) = match codec {
                    FlvVideoCodec::Avc | FlvVideoCodec::Hevc => {
                        if payload.len() < 8 {
                            return Err(CoreError::new(
                                CoreErrorCode::InvalidContainerData,
                                "Enhanced FLV AVC/HEVC coded frame is missing a composition time offset.",
                            ));
                        }
                        (dts_ms + i64::from(read_i24(&payload[5..8])), &payload[8..])
                    }
                    FlvVideoCodec::Av1 => (dts_ms, &payload[5..]),
                };
                self.push_enhanced_sample(codec, frame_type, dts_ms, pts_ms, data, out)
            }
            VIDEO_PACKET_TYPE_CODED_FRAMES_X => {
                if codec == FlvVideoCodec::Av1 {
                    return Err(CoreError::new(
                        CoreErrorCode::InvalidCodecConfig,
                        "Enhanced FLV AV1 does not support CodedFramesX.",
                    ));
                }
                self.push_enhanced_sample(codec, frame_type, dts_ms, dts_ms, &payload[5..], out)
            }
            VIDEO_PACKET_TYPE_SEQUENCE_END => Ok(()),
            VIDEO_PACKET_TYPE_METADATA => {
                out.push(FlvVideoEvent::Warning(CoreWarning::new(
                    "RIVMUX_FLV_ENHANCED_VIDEO_METADATA_SKIPPED",
                    "Enhanced FLV video metadata is not mapped to fMP4 output.",
                )));
                Ok(())
            }
            VIDEO_PACKET_TYPE_MPEG2TS_SEQUENCE_START => Err(CoreError::new(
                CoreErrorCode::UnsupportedVideoCodec,
                "Enhanced FLV MPEG-2 TS sequence start is not supported.",
            )),
            VIDEO_PACKET_TYPE_MULTITRACK => Err(CoreError::new(
                CoreErrorCode::UnsupportedVideoCodec,
                "Enhanced FLV multitrack video is not supported.",
            )),
            VIDEO_PACKET_TYPE_MOD_EX => Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                "Enhanced FLV VideoPacketType.ModEx is not supported.",
            )),
            other => Err(CoreError::new(
                CoreErrorCode::InvalidContainerData,
                format!("Unsupported Enhanced FLV video packet type {other}."),
            )),
        }
    }

    fn push_enhanced_sample(
        &mut self,
        codec: FlvVideoCodec,
        frame_type: u8,
        dts_ms: i64,
        pts_ms: i64,
        data: &[u8],
        out: &mut Vec<FlvVideoEvent>,
    ) -> Result<(), CoreError> {
        let is_sync = match frame_type {
            1 | 4 => true,
            2 => false,
            other => {
                return Err(CoreError::new(
                    CoreErrorCode::InvalidContainerData,
                    format!("Unsupported Enhanced FLV coded-frame type {other}."),
                ));
            }
        };
        let data = match codec {
            FlvVideoCodec::Avc | FlvVideoCodec::Hevc => VideoSampleData::LengthPrefixedNalus(data),
            FlvVideoCodec::Av1 => VideoSampleData::ObuTemporalUnit(data),
        };
        self.push_access_unit(
            codec,
            VideoAccessUnit {
                track_id: TrackId::VIDEO,
                timing: SampleTiming {
                    dts: dts_ms,
                    pts: pts_ms,
                },
                is_sync,
                data,
            },
            out,
        )
    }

    fn push_configuration(
        &mut self,
        codec: FlvVideoCodec,
        data: &[u8],
        out: &mut Vec<FlvVideoEvent>,
    ) -> Result<(), CoreError> {
        let mut events = Vec::new();
        self.normalizer_mut(codec)?
            .on_configuration(data, &mut events)?;
        out.extend(events.into_iter().map(FlvVideoEvent::Normalizer));
        Ok(())
    }

    fn push_access_unit(
        &mut self,
        codec: FlvVideoCodec,
        unit: VideoAccessUnit<'_>,
        out: &mut Vec<FlvVideoEvent>,
    ) -> Result<(), CoreError> {
        let mut events = Vec::new();
        self.normalizer_mut(codec)?
            .push_access_unit(unit, &mut events)?;
        out.extend(events.into_iter().map(FlvVideoEvent::Normalizer));
        Ok(())
    }

    fn normalizer_mut(
        &mut self,
        codec: FlvVideoCodec,
    ) -> Result<&mut FlvVideoNormalizer, CoreError> {
        if let Some(normalizer) = &self.normalizer
            && normalizer.codec() != codec
        {
            return Err(CoreError::new(
                CoreErrorCode::UnsupportedVideoCodec,
                "FLV stream changes video codec after video initialization.",
            ));
        }
        Ok(self
            .normalizer
            .get_or_insert_with(|| FlvVideoNormalizer::new(codec)))
    }
}
