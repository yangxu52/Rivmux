use crate::error::{CoreError, CoreErrorCode};
use crate::probe::VideoCodecKind;

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct VideoConfig {
    pub codec: VideoCodecKind,
    pub codec_string: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub nal_length_size: u8,
    pub avcc: Vec<u8>,
}

pub(crate) fn parse_avc_decoder_configuration_record(
    data: &[u8],
) -> Result<VideoConfig, CoreError> {
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

    let mut dimensions = None;
    for _ in 0..sps_count {
        let sps_length = read_u16(data, offset)? as usize;
        offset += 2;
        ensure_available(data, offset, sps_length, "SPS")?;
        if dimensions.is_none() {
            dimensions = parse_sps_dimensions(&data[offset..offset + sps_length]).ok();
        }
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

    let (width, height) = dimensions
        .map(|(width, height)| (Some(width), Some(height)))
        .unwrap_or((None, None));

    Ok(VideoConfig {
        codec: VideoCodecKind::Avc,
        codec_string: format!("avc1.{profile_idc:02X}{profile_compatibility:02X}{level_idc:02X}"),
        width,
        height,
        nal_length_size,
        avcc: data.to_vec(),
    })
}

fn parse_sps_dimensions(sps: &[u8]) -> Result<(u32, u32), CoreError> {
    if sps.len() < 2 {
        return Err(invalid_sps("AVC SPS is too short."));
    }

    let rbsp = ebsp_to_rbsp(&sps[1..]);
    let mut reader = BitReader::new(&rbsp);
    let profile_idc = reader.read_bits(8)? as u8;
    reader.read_bits(8)?;
    reader.read_bits(8)?;
    reader.read_ue()?;

    let mut chroma_format_idc = 1;
    let mut separate_colour_plane_flag = false;
    if is_high_profile(profile_idc) {
        chroma_format_idc = reader.read_ue()?;
        if chroma_format_idc == 3 {
            separate_colour_plane_flag = reader.read_bool()?;
        }
        reader.read_ue()?;
        reader.read_ue()?;
        reader.read_bool()?;
        if reader.read_bool()? {
            let scaling_list_count = if chroma_format_idc == 3 { 12 } else { 8 };
            for index in 0..scaling_list_count {
                if reader.read_bool()? {
                    skip_scaling_list(&mut reader, if index < 6 { 16 } else { 64 })?;
                }
            }
        }
    }

    reader.read_ue()?;
    let pic_order_cnt_type = reader.read_ue()?;
    if pic_order_cnt_type == 0 {
        reader.read_ue()?;
    } else if pic_order_cnt_type == 1 {
        reader.read_bool()?;
        reader.read_se()?;
        reader.read_se()?;
        let cycle_count = reader.read_ue()?;
        for _ in 0..cycle_count {
            reader.read_se()?;
        }
    }
    reader.read_ue()?;
    reader.read_bool()?;

    let pic_width_in_mbs = reader.read_ue()?.saturating_add(1);
    let pic_height_in_map_units = reader.read_ue()?.saturating_add(1);
    let frame_mbs_only_flag = reader.read_bool()?;
    if !frame_mbs_only_flag {
        reader.read_bool()?;
    }
    reader.read_bool()?;

    let mut crop_left = 0;
    let mut crop_right = 0;
    let mut crop_top = 0;
    let mut crop_bottom = 0;
    if reader.read_bool()? {
        crop_left = reader.read_ue()?;
        crop_right = reader.read_ue()?;
        crop_top = reader.read_ue()?;
        crop_bottom = reader.read_ue()?;
    }

    let frame_height_in_mbs = pic_height_in_map_units
        .checked_mul(if frame_mbs_only_flag { 1 } else { 2 })
        .ok_or_else(|| invalid_sps("AVC SPS frame height overflows."))?;
    let frame_width = pic_width_in_mbs
        .checked_mul(16)
        .ok_or_else(|| invalid_sps("AVC SPS frame width overflows."))?;
    let frame_height = frame_height_in_mbs
        .checked_mul(16)
        .ok_or_else(|| invalid_sps("AVC SPS frame height overflows."))?;
    let (crop_unit_x, crop_unit_y) = crop_units(
        chroma_format_idc,
        separate_colour_plane_flag,
        frame_mbs_only_flag,
    );
    let crop_width = crop_left
        .saturating_add(crop_right)
        .checked_mul(crop_unit_x)
        .ok_or_else(|| invalid_sps("AVC SPS crop width overflows."))?;
    let crop_height = crop_top
        .saturating_add(crop_bottom)
        .checked_mul(crop_unit_y)
        .ok_or_else(|| invalid_sps("AVC SPS crop height overflows."))?;
    let width = frame_width
        .checked_sub(crop_width)
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid_sps("AVC SPS crop exceeds frame width."))?;
    let height = frame_height
        .checked_sub(crop_height)
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid_sps("AVC SPS crop exceeds frame height."))?;

    Ok((width, height))
}

fn ebsp_to_rbsp(data: &[u8]) -> Vec<u8> {
    let mut rbsp = Vec::with_capacity(data.len());
    for &byte in data {
        if byte == 0x03 && rbsp.len() >= 2 && rbsp[rbsp.len() - 1] == 0 && rbsp[rbsp.len() - 2] == 0
        {
            continue;
        }
        rbsp.push(byte);
    }
    rbsp
}

fn is_high_profile(profile_idc: u8) -> bool {
    matches!(
        profile_idc,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    )
}

fn skip_scaling_list(reader: &mut BitReader<'_>, size: usize) -> Result<(), CoreError> {
    let mut last_scale = 8;
    let mut next_scale = 8;
    for _ in 0..size {
        if next_scale != 0 {
            let delta_scale = reader.read_se()?;
            next_scale = (last_scale + delta_scale + 256) % 256;
        }
        if next_scale != 0 {
            last_scale = next_scale;
        }
    }
    Ok(())
}

fn crop_units(
    chroma_format_idc: u32,
    separate_colour_plane_flag: bool,
    frame_mbs_only_flag: bool,
) -> (u32, u32) {
    if chroma_format_idc == 0 || separate_colour_plane_flag {
        return (1, if frame_mbs_only_flag { 1 } else { 2 });
    }

    let (sub_width_c, sub_height_c) = match chroma_format_idc {
        1 => (2, 2),
        2 => (2, 1),
        3 => (1, 1),
        _ => (1, 1),
    };
    (
        sub_width_c,
        sub_height_c * if frame_mbs_only_flag { 1 } else { 2 },
    )
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
        Ok(self.read_bits(1)? == 1)
    }

    fn read_bits(&mut self, count: usize) -> Result<u32, CoreError> {
        if count > 32 {
            return Err(invalid_sps("AVC SPS bit read is too wide."));
        }

        let mut value = 0;
        for _ in 0..count {
            let byte = self
                .data
                .get(self.bit_offset / 8)
                .ok_or_else(|| invalid_sps("AVC SPS ended unexpectedly."))?;
            value = (value << 1) | u32::from((byte >> (7 - (self.bit_offset % 8))) & 1);
            self.bit_offset += 1;
        }
        Ok(value)
    }

    fn read_ue(&mut self) -> Result<u32, CoreError> {
        let mut leading_zero_bits = 0;
        while self.read_bits(1)? == 0 {
            leading_zero_bits += 1;
            if leading_zero_bits > 31 {
                return Err(invalid_sps("AVC SPS Exp-Golomb value is too large."));
            }
        }

        let suffix = if leading_zero_bits == 0 {
            0
        } else {
            self.read_bits(leading_zero_bits)?
        };
        Ok((1u32 << leading_zero_bits) - 1 + suffix)
    }

    fn read_se(&mut self) -> Result<i32, CoreError> {
        let code_num = self.read_ue()? as i32;
        let value = (code_num + 1) / 2;
        if code_num % 2 == 0 {
            Ok(-value)
        } else {
            Ok(value)
        }
    }
}

fn invalid_sps(message: impl Into<String>) -> CoreError {
    CoreError::new(CoreErrorCode::InvalidCodecConfig, message)
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

#[cfg(test)]
mod tests {
    use super::parse_avc_decoder_configuration_record;

    #[test]
    fn parses_baseline_sps_dimensions() {
        let config = parse_avc_decoder_configuration_record(&baseline_320x240_avcc()).unwrap();

        assert_eq!(config.codec_string, "avc1.42C01E");
        assert_eq!(config.width, Some(320));
        assert_eq!(config.height, Some(240));
    }

    fn baseline_320x240_avcc() -> Vec<u8> {
        vec![
            1, 0x42, 0xC0, 0x1E, 0xFF, 0xE1, 0x00, 0x16, 0x67, 0x42, 0xC0, 0x1E, 0xDA, 0x05, 0x07,
            0xEC, 0x04, 0x40, 0x00, 0x00, 0x03, 0x00, 0x40, 0x00, 0x00, 0x0F, 0x23, 0xC5, 0x8B,
            0xA8, 0x01, 0x00, 0x04, 0x68, 0xCE, 0x0F, 0xC8,
        ]
    }
}
