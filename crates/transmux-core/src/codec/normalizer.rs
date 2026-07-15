use crate::codec::{AudioCodecConfig, VideoCodecConfig};
use crate::error::CoreError;
use crate::sample::{EncodedSample, SampleTiming};
use crate::track::TrackId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct VideoAccessUnit<'a> {
    pub(crate) track_id: TrackId,
    pub(crate) timing: SampleTiming,
    pub(crate) is_sync: bool,
    pub(crate) data: VideoSampleData<'a>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VideoSampleData<'a> {
    LengthPrefixedNalus(&'a [u8]),
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "MPEG-TS demuxing will construct Annex-B access units in the next container phase."
        )
    )]
    AnnexB(&'a [u8]),
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "Enhanced FLV and MPEG-TS demuxing will construct AV1 OBU temporal units in later container phases."
        )
    )]
    ObuTemporalUnit(&'a [u8]),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum VideoNormalizerEvent {
    Configuration(VideoCodecConfig),
    Sample(EncodedSample),
}

pub(crate) trait VideoAccessUnitNormalizer {
    fn on_configuration(
        &mut self,
        data: &[u8],
        out: &mut Vec<VideoNormalizerEvent>,
    ) -> Result<(), CoreError>;

    fn push_access_unit(
        &mut self,
        unit: VideoAccessUnit<'_>,
        out: &mut Vec<VideoNormalizerEvent>,
    ) -> Result<(), CoreError>;

    fn flush(&mut self, out: &mut Vec<VideoNormalizerEvent>) -> Result<(), CoreError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AudioAccessUnit<'a> {
    pub(crate) track_id: TrackId,
    pub(crate) timing: SampleTiming,
    pub(crate) input_timescale: u32,
    pub(crate) data: AudioSampleData<'a>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AudioSampleData<'a> {
    RawAac(&'a [u8]),
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "MPEG-TS demuxing will construct ADTS access units in the next container phase."
        )
    )]
    Adts(&'a [u8]),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AudioNormalizerEvent {
    Configuration(AudioCodecConfig),
    Sample(EncodedSample),
}

pub(crate) trait AudioFrameNormalizer {
    fn on_configuration(
        &mut self,
        data: &[u8],
        out: &mut Vec<AudioNormalizerEvent>,
    ) -> Result<(), CoreError>;

    fn push_access_unit(
        &mut self,
        unit: AudioAccessUnit<'_>,
        out: &mut Vec<AudioNormalizerEvent>,
    ) -> Result<(), CoreError>;

    fn flush(&mut self, out: &mut Vec<AudioNormalizerEvent>) -> Result<(), CoreError>;
}
