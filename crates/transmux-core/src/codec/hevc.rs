use crate::codec::VideoCodecConfig;
use crate::codec::normalizer::{
    VideoAccessUnit, VideoAccessUnitNormalizer, VideoNormalizerEvent, VideoSampleData,
};
use crate::error::{CoreError, CoreErrorCode};
use crate::sample::EncodedSample;

const NAL_HEADER_LEN: usize = 2;
const NAL_TYPE_VPS: u8 = 32;
const NAL_TYPE_SPS: u8 = 33;
const NAL_TYPE_PPS: u8 = 34;

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct HevcConfig {
    pub codec_string: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub nal_length_size: u8,
    pub hvcc: Vec<u8>,
}

impl HevcConfig {
    pub(crate) fn from_hvcc(data: &[u8]) -> Result<Self, CoreError> {
        let parsed = parse_hvcc(data)?;
        let dimensions = parsed
            .sps
            .first()
            .and_then(|sps| parse_sps(sps).ok())
            .map(|sps| (Some(sps.width), Some(sps.height)))
            .unwrap_or((None, None));

        Ok(Self {
            codec_string: codec_string(&parsed.profile_tier_level),
            width: dimensions.0,
            height: dimensions.1,
            nal_length_size: parsed.nal_length_size,
            hvcc: data.to_vec(),
        })
    }

    pub(crate) fn from_parameter_sets(
        vps: &[&[u8]],
        sps: &[&[u8]],
        pps: &[&[u8]],
    ) -> Result<Self, CoreError> {
        validate_parameter_sets(vps, NAL_TYPE_VPS, "VPS")?;
        validate_parameter_sets(sps, NAL_TYPE_SPS, "SPS")?;
        validate_parameter_sets(pps, NAL_TYPE_PPS, "PPS")?;

        let sps_info = parse_sps(sps[0])?;
        let num_temporal_layers = sps_info
            .max_sub_layers_minus1
            .checked_add(1)
            .ok_or_else(|| invalid_config("HEVC SPS temporal layer count overflows."))?;
        let chroma_format = u8::try_from(sps_info.chroma_format_idc).map_err(|_| {
            invalid_config("HEVC SPS chroma format exceeds HEVCDecoderConfigurationRecord limits.")
        })?;
        let bit_depth_luma = u8::try_from(sps_info.bit_depth_luma_minus8).map_err(|_| {
            invalid_config("HEVC SPS luma bit depth exceeds HEVCDecoderConfigurationRecord limits.")
        })?;
        let bit_depth_chroma = u8::try_from(sps_info.bit_depth_chroma_minus8).map_err(|_| {
            invalid_config(
                "HEVC SPS chroma bit depth exceeds HEVCDecoderConfigurationRecord limits.",
            )
        })?;
        if chroma_format > 3 || bit_depth_luma > 7 || bit_depth_chroma > 7 {
            return Err(invalid_config(
                "HEVC SPS values exceed HEVCDecoderConfigurationRecord limits.",
            ));
        }

        let profile = sps_info.profile_tier_level;
        let mut hvcc = Vec::new();
        hvcc.push(1);
        hvcc.push(
            (profile.profile_space << 6) | (u8::from(profile.tier_flag) << 5) | profile.profile_idc,
        );
        hvcc.extend_from_slice(&profile.profile_compatibility_flags.to_be_bytes());
        hvcc.extend_from_slice(&profile.constraint_indicator_flags);
        hvcc.push(profile.level_idc);
        hvcc.extend_from_slice(&0xF000_u16.to_be_bytes());
        hvcc.push(0xFC);
        hvcc.push(0xFC | chroma_format);
        hvcc.push(0xF8 | bit_depth_luma);
        hvcc.push(0xF8 | bit_depth_chroma);
        hvcc.extend_from_slice(&0_u16.to_be_bytes());
        hvcc.push(
            (num_temporal_layers << 3) | (u8::from(sps_info.temporal_id_nesting_flag) << 2) | 3,
        );
        hvcc.push(3);
        write_parameter_set_array(&mut hvcc, NAL_TYPE_VPS, vps)?;
        write_parameter_set_array(&mut hvcc, NAL_TYPE_SPS, sps)?;
        write_parameter_set_array(&mut hvcc, NAL_TYPE_PPS, pps)?;

        Self::from_hvcc(&hvcc)
    }
}

#[derive(Debug, Default)]
pub(crate) struct HevcNormalizer {
    config: Option<HevcConfig>,
    vps: Vec<Vec<u8>>,
    sps: Vec<Vec<u8>>,
    pps: Vec<Vec<u8>>,
}

impl VideoAccessUnitNormalizer for HevcNormalizer {
    fn on_configuration(
        &mut self,
        data: &[u8],
        out: &mut Vec<VideoNormalizerEvent>,
    ) -> Result<(), CoreError> {
        let config = HevcConfig::from_hvcc(data)?;
        let parameter_sets = parameter_sets_from_hvcc(data)?;
        self.vps = parameter_sets.vps;
        self.sps = parameter_sets.sps;
        self.pps = parameter_sets.pps;
        self.config = Some(config.clone());
        out.push(VideoNormalizerEvent::Configuration(VideoCodecConfig::Hevc(
            config,
        )));
        Ok(())
    }

    fn push_access_unit(
        &mut self,
        unit: VideoAccessUnit<'_>,
        out: &mut Vec<VideoNormalizerEvent>,
    ) -> Result<(), CoreError> {
        let nalus = match unit.data {
            VideoSampleData::LengthPrefixedNalus(data) => {
                let config = self.config.as_ref().ok_or_else(|| {
                    invalid_config(
                        "HEVC media sample arrived before HEVCDecoderConfigurationRecord.",
                    )
                })?;
                split_length_prefixed_nalus(data, config.nal_length_size)?
            }
            VideoSampleData::AnnexB(data) => split_annex_b_nalus(data)?,
        };
        self.update_parameter_sets(&nalus, out)?;

        // The fMP4 contract emits `hvc1`, whose decoder configuration is out of band in hvcC.
        let media_nalus: Vec<&[u8]> = nalus
            .iter()
            .copied()
            .filter(|nalu| !is_parameter_set(nalu))
            .collect();
        if media_nalus.is_empty() {
            return Ok(());
        }

        let config = self
            .config
            .as_ref()
            .ok_or_else(|| invalid_config("HEVC access unit arrived before VPS, SPS, and PPS."))?;

        let is_sync = unit.is_sync || media_nalus.iter().any(|nalu| is_irap_nalu(nalu));
        out.push(VideoNormalizerEvent::Sample(EncodedSample::Video {
            track_id: unit.track_id,
            timing: unit.timing,
            duration: None,
            is_sync,
            data: length_prefix_nalus(&media_nalus, config.nal_length_size)?,
        }));
        Ok(())
    }

    fn flush(&mut self, _out: &mut Vec<VideoNormalizerEvent>) -> Result<(), CoreError> {
        Ok(())
    }
}

impl HevcNormalizer {
    fn update_parameter_sets(
        &mut self,
        nalus: &[&[u8]],
        out: &mut Vec<VideoNormalizerEvent>,
    ) -> Result<(), CoreError> {
        let vps = collect_parameter_sets(nalus, NAL_TYPE_VPS)?;
        let sps = collect_parameter_sets(nalus, NAL_TYPE_SPS)?;
        let pps = collect_parameter_sets(nalus, NAL_TYPE_PPS)?;
        if vps.is_empty() && sps.is_empty() && pps.is_empty() {
            return Ok(());
        }
        if !vps.is_empty() {
            self.vps = vps;
        }
        if !sps.is_empty() {
            self.sps = sps;
        }
        if !pps.is_empty() {
            self.pps = pps;
        }

        if self.vps.is_empty() || self.sps.is_empty() || self.pps.is_empty() {
            return Ok(());
        }

        let vps: Vec<&[u8]> = self.vps.iter().map(Vec::as_slice).collect();
        let sps: Vec<&[u8]> = self.sps.iter().map(Vec::as_slice).collect();
        let pps: Vec<&[u8]> = self.pps.iter().map(Vec::as_slice).collect();
        let config = HevcConfig::from_parameter_sets(&vps, &sps, &pps)?;
        if self.config.as_ref() != Some(&config) {
            self.config = Some(config.clone());
            out.push(VideoNormalizerEvent::Configuration(VideoCodecConfig::Hevc(
                config,
            )));
        }
        Ok(())
    }
}

struct ParsedHvcc<'a> {
    profile_tier_level: ProfileTierLevel,
    nal_length_size: u8,
    vps: Vec<&'a [u8]>,
    sps: Vec<&'a [u8]>,
    pps: Vec<&'a [u8]>,
}

#[derive(Debug, Clone, Copy)]
struct ProfileTierLevel {
    profile_space: u8,
    tier_flag: bool,
    profile_idc: u8,
    profile_compatibility_flags: u32,
    constraint_indicator_flags: [u8; 6],
    level_idc: u8,
}

struct HevcSps {
    profile_tier_level: ProfileTierLevel,
    max_sub_layers_minus1: u8,
    temporal_id_nesting_flag: bool,
    chroma_format_idc: u32,
    width: u32,
    height: u32,
    bit_depth_luma_minus8: u32,
    bit_depth_chroma_minus8: u32,
}

struct ParameterSets {
    vps: Vec<Vec<u8>>,
    sps: Vec<Vec<u8>>,
    pps: Vec<Vec<u8>>,
}

fn parse_hvcc(data: &[u8]) -> Result<ParsedHvcc<'_>, CoreError> {
    if data.len() < 23 {
        return Err(invalid_config(
            "HEVCDecoderConfigurationRecord is too short.",
        ));
    }
    if data[0] != 1 {
        return Err(invalid_config(
            "Unsupported HEVCDecoderConfigurationRecord version.",
        ));
    }

    let profile_tier_level = ProfileTierLevel {
        profile_space: data[1] >> 6,
        tier_flag: (data[1] & 0x20) != 0,
        profile_idc: data[1] & 0x1F,
        profile_compatibility_flags: u32::from_be_bytes([data[2], data[3], data[4], data[5]]),
        constraint_indicator_flags: [data[6], data[7], data[8], data[9], data[10], data[11]],
        level_idc: data[12],
    };
    let length_size_minus_one = data[21] & 0x03;
    if length_size_minus_one == 2 {
        return Err(invalid_config(
            "HEVC NAL unit length size of 3 bytes is reserved.",
        ));
    }

    let mut offset = 23;
    let mut vps = Vec::new();
    let mut sps = Vec::new();
    let mut pps = Vec::new();
    for _ in 0..data[22] {
        let array_header = *data.get(offset).ok_or_else(|| {
            invalid_config("HEVCDecoderConfigurationRecord has a truncated NAL array header.")
        })?;
        offset += 1;
        let nal_type = array_header & 0x3F;
        let count = usize::from(read_u16(data, offset, "NAL array count")?);
        offset += 2;
        for _ in 0..count {
            let length = usize::from(read_u16(data, offset, "NAL unit length")?);
            offset += 2;
            let nalu = read_slice(data, offset, length, "NAL unit")?;
            offset += length;
            if nalu.len() < NAL_HEADER_LEN {
                return Err(invalid_config(
                    "HEVCDecoderConfigurationRecord contains a truncated NAL unit.",
                ));
            }
            match nal_type {
                NAL_TYPE_VPS => {
                    ensure_nalu_type(nalu, NAL_TYPE_VPS, "VPS", CoreErrorCode::InvalidCodecConfig)?;
                    vps.push(nalu);
                }
                NAL_TYPE_SPS => {
                    ensure_nalu_type(nalu, NAL_TYPE_SPS, "SPS", CoreErrorCode::InvalidCodecConfig)?;
                    sps.push(nalu);
                }
                NAL_TYPE_PPS => {
                    ensure_nalu_type(nalu, NAL_TYPE_PPS, "PPS", CoreErrorCode::InvalidCodecConfig)?;
                    pps.push(nalu);
                }
                _ => {}
            }
        }
    }

    if vps.is_empty() || sps.is_empty() || pps.is_empty() {
        return Err(invalid_config(
            "HEVC configuration must include VPS, SPS, and PPS arrays.",
        ));
    }

    Ok(ParsedHvcc {
        profile_tier_level,
        nal_length_size: length_size_minus_one + 1,
        vps,
        sps,
        pps,
    })
}

fn parameter_sets_from_hvcc(data: &[u8]) -> Result<ParameterSets, CoreError> {
    let parsed = parse_hvcc(data)?;
    Ok(ParameterSets {
        vps: parsed.vps.into_iter().map(ToOwned::to_owned).collect(),
        sps: parsed.sps.into_iter().map(ToOwned::to_owned).collect(),
        pps: parsed.pps.into_iter().map(ToOwned::to_owned).collect(),
    })
}

fn write_parameter_set_array(
    out: &mut Vec<u8>,
    nal_type: u8,
    parameter_sets: &[&[u8]],
) -> Result<(), CoreError> {
    out.push(0x80 | nal_type);
    let count = u16::try_from(parameter_sets.len()).map_err(|_| {
        invalid_config("HEVC parameter set count exceeds HEVCDecoderConfigurationRecord limits.")
    })?;
    out.extend_from_slice(&count.to_be_bytes());
    for parameter_set in parameter_sets {
        let length = u16::try_from(parameter_set.len()).map_err(|_| {
            invalid_config("HEVC parameter set exceeds HEVCDecoderConfigurationRecord limits.")
        })?;
        out.extend_from_slice(&length.to_be_bytes());
        out.extend_from_slice(parameter_set);
    }
    Ok(())
}

fn validate_parameter_sets(
    parameter_sets: &[&[u8]],
    expected_type: u8,
    name: &str,
) -> Result<(), CoreError> {
    if parameter_sets.is_empty() {
        return Err(invalid_config(format!(
            "HEVC parameter sets must include {name}."
        )));
    }
    for parameter_set in parameter_sets {
        ensure_nalu_type(
            parameter_set,
            expected_type,
            name,
            CoreErrorCode::InvalidCodecConfig,
        )?;
    }
    Ok(())
}

fn collect_parameter_sets(nalus: &[&[u8]], target_type: u8) -> Result<Vec<Vec<u8>>, CoreError> {
    let mut parameter_sets = Vec::new();
    for nalu in nalus {
        if nalu_type(nalu)? == target_type {
            parameter_sets.push((*nalu).to_vec());
        }
    }
    Ok(parameter_sets)
}

fn split_annex_b_nalus(data: &[u8]) -> Result<Vec<&[u8]>, CoreError> {
    let Some((first_start, first_length)) = find_start_code(data, 0) else {
        return Err(invalid_container(
            "HEVC Annex-B access unit is missing a start code.",
        ));
    };
    if data[..first_start].iter().any(|byte| *byte != 0) {
        return Err(invalid_container(
            "HEVC Annex-B access unit has data before its first start code.",
        ));
    }

    let mut nalus = Vec::new();
    let mut nalu_start = first_start + first_length;
    while nalu_start < data.len() {
        let next_start_code = find_start_code(data, nalu_start);
        let nalu_end = next_start_code.map_or(data.len(), |(offset, _)| offset);
        let nalu = trim_trailing_zero_bytes(&data[nalu_start..nalu_end]);
        if nalu.len() < NAL_HEADER_LEN {
            return Err(invalid_container(
                "HEVC Annex-B access unit contains a truncated NAL unit.",
            ));
        }
        nalus.push(nalu);

        let Some((next_offset, next_length)) = next_start_code else {
            break;
        };
        nalu_start = next_offset + next_length;
    }

    if nalus.is_empty() {
        return Err(invalid_container(
            "HEVC Annex-B access unit does not contain a NAL unit.",
        ));
    }
    Ok(nalus)
}

fn split_length_prefixed_nalus(data: &[u8], nal_length_size: u8) -> Result<Vec<&[u8]>, CoreError> {
    let nal_length_size = usize::from(nal_length_size);
    let mut offset = 0;
    let mut nalus = Vec::new();
    while offset < data.len() {
        let length_end = offset
            .checked_add(nal_length_size)
            .ok_or_else(|| invalid_container("HEVC access unit NAL length offset overflows."))?;
        let length_bytes = data.get(offset..length_end).ok_or_else(|| {
            invalid_container("HEVC access unit ends before a NAL length prefix.")
        })?;
        let length = length_bytes
            .iter()
            .fold(0usize, |value, byte| (value << 8) | usize::from(*byte));
        offset = length_end;
        let nalu_end = offset
            .checked_add(length)
            .ok_or_else(|| invalid_container("HEVC access unit NAL length overflows."))?;
        let nalu = data
            .get(offset..nalu_end)
            .ok_or_else(|| invalid_container("HEVC access unit has a truncated NAL unit."))?;
        if nalu.len() < NAL_HEADER_LEN {
            return Err(invalid_container(
                "HEVC access unit contains a truncated NAL unit.",
            ));
        }
        nalus.push(nalu);
        offset = nalu_end;
    }
    Ok(nalus)
}

fn length_prefix_nalus(nalus: &[&[u8]], nal_length_size: u8) -> Result<Vec<u8>, CoreError> {
    let nal_length_size = usize::from(nal_length_size);
    let max_nalu_length = (1_u64 << (nal_length_size * 8)) - 1;
    let payload_length = nalus
        .iter()
        .try_fold(0usize, |total, nalu| {
            total
                .checked_add(nal_length_size)
                .and_then(|value| value.checked_add(nalu.len()))
        })
        .ok_or_else(|| invalid_container("HEVC access unit output size overflows."))?;
    let mut out = Vec::with_capacity(payload_length);
    for nalu in nalus {
        let length = u64::try_from(nalu.len())
            .map_err(|_| invalid_container("HEVC NAL length overflows."))?;
        if length > max_nalu_length {
            return Err(invalid_container(
                "HEVC NAL exceeds the configured length-prefix capacity.",
            ));
        }
        for index in (0..nal_length_size).rev() {
            out.push((length >> (index * 8)) as u8);
        }
        out.extend_from_slice(nalu);
    }
    Ok(out)
}

fn find_start_code(data: &[u8], start: usize) -> Option<(usize, usize)> {
    let mut index = start;
    while index + 3 <= data.len() {
        if data[index] == 0 && data[index + 1] == 0 {
            if data.get(index + 2) == Some(&0) && data.get(index + 3) == Some(&1) {
                return Some((index, 4));
            }
            if data.get(index + 2) == Some(&1) {
                return Some((index, 3));
            }
        }
        index += 1;
    }
    None
}

fn trim_trailing_zero_bytes(mut nalu: &[u8]) -> &[u8] {
    while nalu.last() == Some(&0) {
        nalu = &nalu[..nalu.len() - 1];
    }
    nalu
}

fn is_parameter_set(nalu: &[u8]) -> bool {
    matches!(
        nalu_type(nalu),
        Ok(NAL_TYPE_VPS | NAL_TYPE_SPS | NAL_TYPE_PPS)
    )
}

fn is_irap_nalu(nalu: &[u8]) -> bool {
    matches!(nalu_type(nalu), Ok(16..=21))
}

fn nalu_type(nalu: &[u8]) -> Result<u8, CoreError> {
    nalu.first()
        .map(|byte| (byte >> 1) & 0x3F)
        .ok_or_else(|| invalid_container("HEVC NAL unit is empty."))
}

fn ensure_nalu_type(
    nalu: &[u8],
    expected_type: u8,
    name: &str,
    code: CoreErrorCode,
) -> Result<(), CoreError> {
    if nalu.len() < NAL_HEADER_LEN {
        return Err(CoreError::new(
            code,
            format!("HEVC {name} is shorter than a NAL header."),
        ));
    }
    let actual_type = (nalu[0] >> 1) & 0x3F;
    if actual_type != expected_type {
        return Err(CoreError::new(
            code,
            format!("HEVC {name} has NAL unit type {actual_type}, expected {expected_type}."),
        ));
    }
    Ok(())
}

fn parse_sps(sps: &[u8]) -> Result<HevcSps, CoreError> {
    ensure_nalu_type(sps, NAL_TYPE_SPS, "SPS", CoreErrorCode::InvalidCodecConfig)?;
    let rbsp = ebsp_to_rbsp(&sps[NAL_HEADER_LEN..]);
    let mut reader = BitReader::new(&rbsp);
    reader.read_bits(4)?;
    let max_sub_layers_minus1 = reader.read_bits(3)? as u8;
    if max_sub_layers_minus1 > 6 {
        return Err(invalid_config(
            "HEVC SPS max_sub_layers_minus1 exceeds the HEVC limit.",
        ));
    }
    let temporal_id_nesting_flag = reader.read_bool()?;
    let profile_tier_level = ProfileTierLevel::read(&mut reader, max_sub_layers_minus1)?;
    reader.read_ue()?;
    let chroma_format_idc = reader.read_ue()?;
    if chroma_format_idc > 3 {
        return Err(invalid_config("HEVC SPS chroma_format_idc is invalid."));
    }
    if chroma_format_idc == 3 {
        reader.read_bool()?;
    }
    let pic_width_in_luma_samples = reader.read_ue()?;
    let pic_height_in_luma_samples = reader.read_ue()?;
    let (left_offset, right_offset, top_offset, bottom_offset) = if reader.read_bool()? {
        (
            reader.read_ue()?,
            reader.read_ue()?,
            reader.read_ue()?,
            reader.read_ue()?,
        )
    } else {
        (0, 0, 0, 0)
    };
    let bit_depth_luma_minus8 = reader.read_ue()?;
    let bit_depth_chroma_minus8 = reader.read_ue()?;

    let (sub_width_c, sub_height_c) = match chroma_format_idc {
        0 => (1, 1),
        1 => (2, 2),
        2 => (2, 1),
        3 => (1, 1),
        _ => unreachable!("chroma format is validated above"),
    };
    let crop_width = left_offset
        .checked_add(right_offset)
        .and_then(|value| value.checked_mul(sub_width_c))
        .ok_or_else(|| invalid_config("HEVC SPS conformance crop width overflows."))?;
    let crop_height = top_offset
        .checked_add(bottom_offset)
        .and_then(|value| value.checked_mul(sub_height_c))
        .ok_or_else(|| invalid_config("HEVC SPS conformance crop height overflows."))?;
    let width = pic_width_in_luma_samples
        .checked_sub(crop_width)
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid_config("HEVC SPS conformance crop exceeds frame width."))?;
    let height = pic_height_in_luma_samples
        .checked_sub(crop_height)
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid_config("HEVC SPS conformance crop exceeds frame height."))?;

    Ok(HevcSps {
        profile_tier_level,
        max_sub_layers_minus1,
        temporal_id_nesting_flag,
        chroma_format_idc,
        width,
        height,
        bit_depth_luma_minus8,
        bit_depth_chroma_minus8,
    })
}

impl ProfileTierLevel {
    fn read(reader: &mut BitReader<'_>, max_sub_layers_minus1: u8) -> Result<Self, CoreError> {
        let profile_space = reader.read_bits(2)? as u8;
        let tier_flag = reader.read_bool()?;
        let profile_idc = reader.read_bits(5)? as u8;
        let profile_compatibility_flags = reader.read_bits(32)?;
        let mut constraint_indicator_flags = [0; 6];
        for byte in &mut constraint_indicator_flags {
            *byte = reader.read_bits(8)? as u8;
        }
        let level_idc = reader.read_bits(8)? as u8;

        let mut sub_layer_profile_present = [false; 6];
        let mut sub_layer_level_present = [false; 6];
        for index in 0..usize::from(max_sub_layers_minus1) {
            sub_layer_profile_present[index] = reader.read_bool()?;
            sub_layer_level_present[index] = reader.read_bool()?;
        }
        if max_sub_layers_minus1 > 0 {
            for _ in max_sub_layers_minus1..8 {
                reader.read_bits(2)?;
            }
        }
        for index in 0..usize::from(max_sub_layers_minus1) {
            if sub_layer_profile_present[index] {
                reader.read_bits(2)?;
                reader.read_bool()?;
                reader.read_bits(5)?;
                reader.read_bits(32)?;
                reader.skip_bits(48)?;
            }
            if sub_layer_level_present[index] {
                reader.read_bits(8)?;
            }
        }

        Ok(Self {
            profile_space,
            tier_flag,
            profile_idc,
            profile_compatibility_flags,
            constraint_indicator_flags,
            level_idc,
        })
    }
}

fn codec_string(profile: &ProfileTierLevel) -> String {
    let profile_space = match profile.profile_space {
        0 => "",
        1 => "A",
        2 => "B",
        3 => "C",
        _ => unreachable!("profile space is a two-bit field"),
    };
    let tier = if profile.tier_flag { 'H' } else { 'L' };
    let compatibility = profile.profile_compatibility_flags.reverse_bits();
    let mut codec = format!(
        "hvc1.{profile_space}{}.{compatibility}.{tier}{}",
        profile.profile_idc, profile.level_idc
    );
    if let Some(constraints) = constraint_string(&profile.constraint_indicator_flags) {
        codec.push('.');
        codec.push_str(&constraints);
    }
    codec
}

fn constraint_string(flags: &[u8; 6]) -> Option<String> {
    let last_non_zero = flags.iter().rposition(|byte| *byte != 0)?;
    Some(
        flags[..=last_non_zero]
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect(),
    )
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
            return Err(invalid_config("HEVC SPS bit read is too wide."));
        }

        let mut value = 0;
        for _ in 0..count {
            let byte = self
                .data
                .get(self.bit_offset / 8)
                .ok_or_else(|| invalid_config("HEVC SPS ended unexpectedly."))?;
            value = (value << 1) | u32::from((byte >> (7 - (self.bit_offset % 8))) & 1);
            self.bit_offset += 1;
        }
        Ok(value)
    }

    fn skip_bits(&mut self, mut count: usize) -> Result<(), CoreError> {
        while count > 0 {
            let chunk = count.min(32);
            self.read_bits(chunk)?;
            count -= chunk;
        }
        Ok(())
    }

    fn read_ue(&mut self) -> Result<u32, CoreError> {
        let mut leading_zero_bits = 0;
        while self.read_bits(1)? == 0 {
            leading_zero_bits += 1;
            if leading_zero_bits > 31 {
                return Err(invalid_config("HEVC SPS Exp-Golomb value is too large."));
            }
        }

        let suffix = if leading_zero_bits == 0 {
            0
        } else {
            self.read_bits(leading_zero_bits)?
        };
        Ok((1u32 << leading_zero_bits) - 1 + suffix)
    }
}

fn read_u16(data: &[u8], offset: usize, field: &str) -> Result<u16, CoreError> {
    let bytes = read_slice(data, offset, 2, field)?;
    Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
}

fn read_slice<'a>(
    data: &'a [u8],
    offset: usize,
    length: usize,
    field: &str,
) -> Result<&'a [u8], CoreError> {
    let end = offset
        .checked_add(length)
        .ok_or_else(|| invalid_config(format!("HEVC configuration {field} offset overflows.")))?;
    data.get(offset..end)
        .ok_or_else(|| invalid_config(format!("HEVC configuration has truncated {field}.")))
}

fn invalid_config(message: impl Into<String>) -> CoreError {
    CoreError::new(CoreErrorCode::InvalidCodecConfig, message)
}

fn invalid_container(message: impl Into<String>) -> CoreError {
    CoreError::new(CoreErrorCode::InvalidContainerData, message)
}

#[cfg(test)]
mod tests {
    use super::{HevcConfig, HevcNormalizer};
    use crate::codec::normalizer::{
        VideoAccessUnit, VideoAccessUnitNormalizer, VideoNormalizerEvent, VideoSampleData,
    };
    use crate::sample::{EncodedSample, SampleTiming};
    use crate::track::TrackId;

    #[test]
    fn builds_hvcc_and_parses_sps_dimensions() {
        let vps = minimal_vps();
        let sps = minimal_sps(1920, 1080);
        let pps = minimal_pps();
        let config = HevcConfig::from_parameter_sets(&[&vps], &[&sps], &[&pps]).unwrap();

        assert_eq!(config.codec_string, "hvc1.1.6.L120");
        assert_eq!(config.width, Some(1920));
        assert_eq!(config.height, Some(1080));
        assert_eq!(config.nal_length_size, 4);
        assert_eq!(config.hvcc[0], 1);
    }

    #[test]
    fn formats_rfc_6381_constraint_indicator_flags() {
        let vps = minimal_vps();
        let sps = minimal_sps(1920, 1080);
        let pps = minimal_pps();
        let mut hvcc = HevcConfig::from_parameter_sets(&[&vps], &[&sps], &[&pps])
            .unwrap()
            .hvcc;
        hvcc[6] = 0xB0;

        let config = HevcConfig::from_hvcc(&hvcc).unwrap();

        assert_eq!(config.codec_string, "hvc1.1.6.L120.B0");
    }

    #[test]
    fn normalizes_annex_b_and_marks_irap_as_sync() {
        let vps = minimal_vps();
        let sps = minimal_sps(640, 360);
        let pps = minimal_pps();
        let idr = [0x26, 0x01, 0x80];
        let mut access_unit = Vec::new();
        for nalu in [&vps[..], &sps[..], &pps[..], &idr] {
            access_unit.extend_from_slice(&[0, 0, 0, 1]);
            access_unit.extend_from_slice(nalu);
        }

        let mut normalizer = HevcNormalizer::default();
        let mut events = Vec::new();
        normalizer
            .push_access_unit(
                VideoAccessUnit {
                    track_id: TrackId::VIDEO,
                    timing: SampleTiming {
                        dts: 90_000,
                        pts: 90_000,
                    },
                    is_sync: false,
                    data: VideoSampleData::AnnexB(&access_unit),
                },
                &mut events,
            )
            .unwrap();

        assert!(matches!(
            events.as_slice(),
            [
                VideoNormalizerEvent::Configuration(_),
                VideoNormalizerEvent::Sample(EncodedSample::Video {
                    is_sync: true,
                    data,
                    ..
                })
            ] if *data == [0, 0, 0, 3, 0x26, 0x01, 0x80]
        ));
    }

    #[test]
    fn caches_parameter_sets_across_access_units() {
        let vps = minimal_vps();
        let sps = minimal_sps(640, 360);
        let pps = minimal_pps();
        let mut normalizer = HevcNormalizer::default();
        let mut events = Vec::new();

        for nalu in [&vps[..], &sps[..], &pps[..]] {
            let mut access_unit = vec![0, 0, 1];
            access_unit.extend_from_slice(nalu);
            normalizer
                .push_access_unit(
                    VideoAccessUnit {
                        track_id: TrackId::VIDEO,
                        timing: SampleTiming { dts: 0, pts: 0 },
                        is_sync: false,
                        data: VideoSampleData::AnnexB(&access_unit),
                    },
                    &mut events,
                )
                .unwrap();
        }
        assert!(matches!(
            events.as_slice(),
            [VideoNormalizerEvent::Configuration(_)]
        ));

        events.clear();
        normalizer
            .push_access_unit(
                VideoAccessUnit {
                    track_id: TrackId::VIDEO,
                    timing: SampleTiming {
                        dts: 3_600,
                        pts: 3_600,
                    },
                    is_sync: false,
                    data: VideoSampleData::AnnexB(&[0, 0, 1, 0x2A, 0x01, 0x80]),
                },
                &mut events,
            )
            .unwrap();
        assert!(matches!(
            events.as_slice(),
            [VideoNormalizerEvent::Sample(EncodedSample::Video {
                is_sync: true,
                ..
            })]
        ));
    }

    #[test]
    fn preserves_hvcc_configuration_for_length_prefixed_samples() {
        let vps = minimal_vps();
        let sps = minimal_sps(640, 360);
        let pps = minimal_pps();
        let config = HevcConfig::from_parameter_sets(&[&vps], &[&sps], &[&pps]).unwrap();
        let mut normalizer = HevcNormalizer::default();
        let mut events = Vec::new();
        normalizer
            .on_configuration(&config.hvcc, &mut events)
            .unwrap();

        events.clear();
        normalizer
            .push_access_unit(
                VideoAccessUnit {
                    track_id: TrackId::VIDEO,
                    timing: SampleTiming { dts: 0, pts: 0 },
                    is_sync: false,
                    data: VideoSampleData::LengthPrefixedNalus(&[0, 0, 0, 3, 0x2A, 0x01, 0x80]),
                },
                &mut events,
            )
            .unwrap();

        assert!(matches!(
            events.as_slice(),
            [VideoNormalizerEvent::Sample(EncodedSample::Video {
                is_sync: true,
                data,
                ..
            })] if *data == [0, 0, 0, 3, 0x2A, 0x01, 0x80]
        ));
    }

    struct BitWriter {
        bytes: Vec<u8>,
        bit_offset: usize,
    }

    impl BitWriter {
        fn new() -> Self {
            Self {
                bytes: Vec::new(),
                bit_offset: 0,
            }
        }

        fn write_bits(&mut self, value: u64, count: usize) {
            for shift in (0..count).rev() {
                if self.bit_offset.is_multiple_of(8) {
                    self.bytes.push(0);
                }
                let bit = ((value >> shift) & 1) as u8;
                let byte_index = self.bytes.len() - 1;
                self.bytes[byte_index] |= bit << (7 - (self.bit_offset % 8));
                self.bit_offset += 1;
            }
        }

        fn write_ue(&mut self, value: u32) {
            let code_num = value.saturating_add(1);
            let bit_count = 32 - code_num.leading_zeros() as usize;
            self.write_bits(0, bit_count - 1);
            self.write_bits(u64::from(code_num), bit_count);
        }

        fn into_bytes(mut self) -> Vec<u8> {
            self.write_bits(1, 1);
            while !self.bit_offset.is_multiple_of(8) {
                self.write_bits(0, 1);
            }
            self.bytes
        }
    }

    fn minimal_vps() -> Vec<u8> {
        vec![0x40, 0x01, 0x0C]
    }

    fn minimal_sps(width: u32, height: u32) -> Vec<u8> {
        let mut writer = BitWriter::new();
        writer.write_bits(0, 4);
        writer.write_bits(0, 3);
        writer.write_bits(1, 1);
        writer.write_bits(0, 2);
        writer.write_bits(0, 1);
        writer.write_bits(1, 5);
        writer.write_bits(0x6000_0000, 32);
        writer.write_bits(0, 48);
        writer.write_bits(120, 8);
        writer.write_ue(0);
        writer.write_ue(1);
        writer.write_ue(width);
        writer.write_ue(height);
        writer.write_bits(0, 1);
        writer.write_ue(0);
        writer.write_ue(0);

        let mut sps = vec![0x42, 0x01];
        sps.extend_from_slice(&writer.into_bytes());
        sps
    }

    fn minimal_pps() -> Vec<u8> {
        vec![0x44, 0x01, 0xC0]
    }
}
