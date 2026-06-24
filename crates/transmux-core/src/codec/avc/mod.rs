use crate::error::{CoreError, CoreErrorCode};
use crate::probe::VideoCodecKind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoConfig {
    pub codec: VideoCodecKind,
    pub codec_string: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub nal_length_size: u8,
    pub avcc: Vec<u8>,
}

pub fn parse_avc_decoder_configuration_record(data: &[u8]) -> Result<VideoConfig, CoreError> {
    if data.len() < 7 {
        return Err(CoreError::new(
            CoreErrorCode::InvalidCodecConfig,
            "AVCDecoderConfigurationRecord is too short.",
        ));
    }

    if data[0] != 1 {
        return Err(CoreError::new(
            CoreErrorCode::InvalidCodecConfig,
            "Unsupported AVCDecoderConfigurationRecord version.",
        ));
    }

    let profile_idc = data[1];
    let profile_compatibility = data[2];
    let level_idc = data[3];
    let length_size_minus_one = data[4] & 0b0000_0011;
    if length_size_minus_one == 2 {
        return Err(CoreError::new(
            CoreErrorCode::InvalidCodecConfig,
            "AVC NAL unit length size of 3 bytes is reserved.",
        ));
    }
    let nal_length_size = length_size_minus_one + 1;

    let mut offset = 5;
    let sps_count = data[offset] & 0b0001_1111;
    offset += 1;
    if sps_count == 0 {
        return Err(CoreError::new(
            CoreErrorCode::InvalidCodecConfig,
            "AVC configuration is missing SPS.",
        ));
    }

    for _ in 0..sps_count {
        let sps_length = read_u16(data, offset)? as usize;
        offset += 2;
        ensure_available(data, offset, sps_length, "SPS")?;
        offset += sps_length;
    }

    ensure_available(data, offset, 1, "PPS count")?;
    let pps_count = data[offset];
    offset += 1;
    if pps_count == 0 {
        return Err(CoreError::new(
            CoreErrorCode::InvalidCodecConfig,
            "AVC configuration is missing PPS.",
        ));
    }

    for _ in 0..pps_count {
        let pps_length = read_u16(data, offset)? as usize;
        offset += 2;
        ensure_available(data, offset, pps_length, "PPS")?;
        offset += pps_length;
    }

    Ok(VideoConfig {
        codec: VideoCodecKind::Avc,
        codec_string: format!("avc1.{profile_idc:02X}{profile_compatibility:02X}{level_idc:02X}"),
        width: None,
        height: None,
        nal_length_size,
        avcc: data.to_vec(),
    })
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16, CoreError> {
    ensure_available(data, offset, 2, "u16")?;
    Ok(u16::from_be_bytes([data[offset], data[offset + 1]]))
}

fn ensure_available(
    data: &[u8],
    offset: usize,
    length: usize,
    field: &str,
) -> Result<(), CoreError> {
    if offset
        .checked_add(length)
        .is_some_and(|end| end <= data.len())
    {
        return Ok(());
    }

    Err(CoreError::new(
        CoreErrorCode::InvalidCodecConfig,
        format!("AVC configuration has truncated {field}."),
    ))
}
