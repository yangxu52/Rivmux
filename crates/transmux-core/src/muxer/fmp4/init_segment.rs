use crate::codec::aac::AacConfig;
use crate::codec::av1::Av1Config;
use crate::codec::avc::AvcConfig;
use crate::codec::hevc::HevcConfig;
use crate::codec::opus::{OPUS_SAMPLE_RATE, OpusConfig};
use crate::codec::{AudioCodecConfig, VideoCodecConfig};
use crate::muxer::fmp4::boxes::{
    concat_box, write_box, write_fixed_16_16, write_full_box, write_u16, write_u32,
};
use crate::track::{AudioTrackConfig, VideoTrackConfig};

const AUDIO_SAMPLE_SIZE: u16 = 16;

pub(super) trait Fmp4VideoCodec {
    fn codec_string(&self) -> &str;
    fn compatible_brand(&self) -> &[u8; 4];
    fn sample_entry(&self) -> Vec<u8>;
    fn dimensions(&self) -> (Option<u32>, Option<u32>);
}

impl Fmp4VideoCodec for VideoCodecConfig {
    fn codec_string(&self) -> &str {
        self.codec_string()
    }

    fn compatible_brand(&self) -> &[u8; 4] {
        match self {
            Self::Avc(_) => b"avc1",
            Self::Hevc(_) => b"hvc1",
            Self::Av1(_) => b"av01",
        }
    }

    fn sample_entry(&self) -> Vec<u8> {
        match self {
            Self::Avc(config) => avc1(config),
            Self::Hevc(config) => hvc1(config),
            Self::Av1(config) => av01(config),
        }
    }

    fn dimensions(&self) -> (Option<u32>, Option<u32>) {
        self.dimensions()
    }
}

pub(super) trait Fmp4AudioCodec {
    fn codec_string(&self) -> &str;
    fn compatible_brand(&self) -> &[u8; 4];
    fn sample_entry(&self) -> Vec<u8>;
}

impl Fmp4AudioCodec for AudioCodecConfig {
    fn codec_string(&self) -> &str {
        self.codec_string()
    }

    fn compatible_brand(&self) -> &[u8; 4] {
        match self {
            Self::Aac(_) => b"mp4a",
            Self::Opus(_) => b"Opus",
        }
    }

    fn sample_entry(&self) -> Vec<u8> {
        match self {
            Self::Aac(config) => mp4a(config),
            Self::Opus(config) => opus(config),
        }
    }
}

pub(super) fn video_timescale(config: &VideoTrackConfig) -> u32 {
    config.clock.fmp4_timescale()
}

pub(super) fn build_video_init_segment(config: &VideoTrackConfig) -> Vec<u8> {
    concat_box(vec![
        ftyp(&[config.codec.compatible_brand()]),
        video_moov(config),
    ])
}

pub(super) fn audio_timescale(config: &AudioTrackConfig) -> u32 {
    config.clock.fmp4_timescale()
}

pub(super) fn build_audio_init_segment(config: &AudioTrackConfig) -> Vec<u8> {
    concat_box(vec![
        ftyp(&[config.codec.compatible_brand()]),
        audio_moov(config),
    ])
}

fn ftyp(codec_brands: &[&[u8; 4]]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(b"iso6");
    write_u32(&mut payload, 1);
    payload.extend_from_slice(b"iso6");
    payload.extend_from_slice(b"mp41");
    for codec_brand in codec_brands {
        payload.extend_from_slice(*codec_brand);
    }
    payload.extend_from_slice(b"dash");
    write_box(b"ftyp", payload)
}

fn video_moov(config: &VideoTrackConfig) -> Vec<u8> {
    let track_id = config.id.get();
    write_box(
        b"moov",
        concat_box(vec![
            mvhd(video_timescale(config), track_id.saturating_add(1)),
            video_trak(config),
            mvex(&[track_id]),
        ]),
    )
}

fn audio_moov(config: &AudioTrackConfig) -> Vec<u8> {
    let track_id = config.id.get();
    write_box(
        b"moov",
        concat_box(vec![
            mvhd(audio_timescale(config), track_id.saturating_add(1)),
            audio_trak(config),
            mvex(&[track_id]),
        ]),
    )
}

fn mvhd(timescale: u32, next_track_id: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, timescale);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0x0001_0000);
    write_u16(&mut payload, 0x0100);
    write_u16(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_matrix(&mut payload);
    for _ in 0..6 {
        write_u32(&mut payload, 0);
    }
    write_u32(&mut payload, next_track_id);
    write_full_box(b"mvhd", 0, 0, payload)
}

fn video_trak(config: &VideoTrackConfig) -> Vec<u8> {
    write_box(
        b"trak",
        concat_box(vec![video_tkhd(config), video_mdia(config)]),
    )
}

fn audio_trak(config: &AudioTrackConfig) -> Vec<u8> {
    write_box(
        b"trak",
        concat_box(vec![audio_tkhd(config), audio_mdia(config)]),
    )
}

fn video_tkhd(config: &VideoTrackConfig) -> Vec<u8> {
    let (width, height) = dimensions(&config.codec);
    let mut payload = Vec::new();
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, config.id.get());
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u16(&mut payload, 0);
    write_u16(&mut payload, 0);
    write_u16(&mut payload, 0);
    write_u16(&mut payload, 0);
    write_matrix(&mut payload);
    write_fixed_16_16(&mut payload, width);
    write_fixed_16_16(&mut payload, height);
    write_full_box(b"tkhd", 0, 0x0000_0007, payload)
}

fn audio_tkhd(config: &AudioTrackConfig) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, config.id.get());
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u16(&mut payload, 0);
    write_u16(&mut payload, 0);
    write_u16(&mut payload, 0x0100);
    write_u16(&mut payload, 0);
    write_matrix(&mut payload);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_full_box(b"tkhd", 0, 0x0000_0007, payload)
}

fn video_mdia(config: &VideoTrackConfig) -> Vec<u8> {
    write_box(
        b"mdia",
        concat_box(vec![
            mdhd(video_timescale(config)),
            video_hdlr(),
            video_minf(config),
        ]),
    )
}

fn audio_mdia(config: &AudioTrackConfig) -> Vec<u8> {
    write_box(
        b"mdia",
        concat_box(vec![
            mdhd(audio_timescale(config)),
            audio_hdlr(),
            audio_minf(config),
        ]),
    )
}

fn mdhd(timescale: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, timescale);
    write_u32(&mut payload, 0);
    write_u16(&mut payload, 0x55C4);
    write_u16(&mut payload, 0);
    write_full_box(b"mdhd", 0, 0, payload)
}

fn video_hdlr() -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 0);
    payload.extend_from_slice(b"vide");
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    payload.extend_from_slice(b"VideoHandler\0");
    write_full_box(b"hdlr", 0, 0, payload)
}

fn audio_hdlr() -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 0);
    payload.extend_from_slice(b"soun");
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    payload.extend_from_slice(b"SoundHandler\0");
    write_full_box(b"hdlr", 0, 0, payload)
}

fn video_minf(config: &VideoTrackConfig) -> Vec<u8> {
    write_box(
        b"minf",
        concat_box(vec![vmhd(), dinf(), video_stbl(config)]),
    )
}

fn audio_minf(config: &AudioTrackConfig) -> Vec<u8> {
    write_box(
        b"minf",
        concat_box(vec![smhd(), dinf(), audio_stbl(config)]),
    )
}

fn vmhd() -> Vec<u8> {
    let mut payload = Vec::new();
    write_u16(&mut payload, 0);
    write_u16(&mut payload, 0);
    write_u16(&mut payload, 0);
    write_u16(&mut payload, 0);
    write_full_box(b"vmhd", 0, 1, payload)
}

fn smhd() -> Vec<u8> {
    let mut payload = Vec::new();
    write_u16(&mut payload, 0);
    write_u16(&mut payload, 0);
    write_full_box(b"smhd", 0, 0, payload)
}

fn dinf() -> Vec<u8> {
    let mut dref_payload = Vec::new();
    write_u32(&mut dref_payload, 1);
    dref_payload.extend_from_slice(&write_full_box(b"url ", 0, 1, Vec::new()));
    write_box(b"dinf", write_full_box(b"dref", 0, 0, dref_payload))
}

fn video_stbl(config: &VideoTrackConfig) -> Vec<u8> {
    write_box(
        b"stbl",
        concat_box(vec![
            video_stsd(config),
            empty_table(b"stts"),
            empty_table(b"stsc"),
            stsz(),
            empty_table(b"stco"),
        ]),
    )
}

fn audio_stbl(config: &AudioTrackConfig) -> Vec<u8> {
    write_box(
        b"stbl",
        concat_box(vec![
            audio_stsd(config),
            empty_table(b"stts"),
            empty_table(b"stsc"),
            stsz(),
            empty_table(b"stco"),
        ]),
    )
}

fn video_stsd(config: &VideoTrackConfig) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 1);
    payload.extend_from_slice(&config.codec.sample_entry());
    write_full_box(b"stsd", 0, 0, payload)
}

fn audio_stsd(config: &AudioTrackConfig) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 1);
    payload.extend_from_slice(&config.codec.sample_entry());
    write_full_box(b"stsd", 0, 0, payload)
}

fn avc1(config: &AvcConfig) -> Vec<u8> {
    visual_sample_entry(b"avc1", b"avcC", &config.avcc, config.width, config.height)
}

fn hvc1(config: &HevcConfig) -> Vec<u8> {
    visual_sample_entry(b"hvc1", b"hvcC", &config.hvcc, config.width, config.height)
}

fn av01(config: &Av1Config) -> Vec<u8> {
    visual_sample_entry(b"av01", b"av1C", &config.av1c, config.width, config.height)
}

fn visual_sample_entry(
    sample_entry_type: &[u8; 4],
    configuration_type: &[u8; 4],
    configuration: &[u8],
    width: Option<u32>,
    height: Option<u32>,
) -> Vec<u8> {
    let width = width.unwrap_or(1).clamp(1, u16::MAX as u32) as u16;
    let height = height.unwrap_or(1).clamp(1, u16::MAX as u32) as u16;
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0; 6]);
    write_u16(&mut payload, 1);
    write_u16(&mut payload, 0);
    write_u16(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u16(&mut payload, width);
    write_u16(&mut payload, height);
    write_u32(&mut payload, 0x0048_0000);
    write_u32(&mut payload, 0x0048_0000);
    write_u32(&mut payload, 0);
    write_u16(&mut payload, 1);
    payload.extend_from_slice(&[0; 32]);
    write_u16(&mut payload, 0x0018);
    write_u16(&mut payload, 0xFFFF);
    payload.extend_from_slice(&write_box(configuration_type, configuration.to_vec()));
    write_box(sample_entry_type, payload)
}

fn mp4a(config: &AacConfig) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0; 6]);
    write_u16(&mut payload, 1);
    payload.extend_from_slice(&[0; 8]);
    write_u16(&mut payload, config.channel_count as u16);
    write_u16(&mut payload, AUDIO_SAMPLE_SIZE);
    write_u16(&mut payload, 0);
    write_u16(&mut payload, 0);
    write_u32(&mut payload, config.sample_rate.min(u16::MAX as u32) << 16);
    payload.extend_from_slice(&esds(config));
    write_box(b"mp4a", payload)
}

fn opus(config: &OpusConfig) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0; 6]);
    write_u16(&mut payload, 1);
    payload.extend_from_slice(&[0; 8]);
    write_u16(&mut payload, config.channel_count as u16);
    write_u16(&mut payload, AUDIO_SAMPLE_SIZE);
    write_u16(&mut payload, 0);
    write_u16(&mut payload, 0);
    write_u32(&mut payload, OPUS_SAMPLE_RATE << 16);
    payload.extend_from_slice(&dops(config));
    write_box(b"Opus", payload)
}

fn dops(config: &OpusConfig) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.push(0);
    payload.push(config.channel_count);
    write_u16(&mut payload, config.pre_skip);
    write_u32(&mut payload, config.input_sample_rate);
    write_u16(&mut payload, config.output_gain as u16);
    payload.push(0);
    write_box(b"dOps", payload)
}

fn esds(config: &AacConfig) -> Vec<u8> {
    let decoder_specific_info = descriptor(0x05, config.audio_specific_config.clone());

    let mut decoder_config = Vec::new();
    decoder_config.push(0x40);
    decoder_config.push(0x15);
    decoder_config.extend_from_slice(&[0, 0, 0]);
    write_u32(&mut decoder_config, 0);
    write_u32(&mut decoder_config, 0);
    decoder_config.extend_from_slice(&decoder_specific_info);

    let decoder_config_descriptor = descriptor(0x04, decoder_config);
    let sl_config_descriptor = descriptor(0x06, vec![0x02]);

    let mut elementary_stream = Vec::new();
    write_u16(&mut elementary_stream, 1);
    elementary_stream.push(0);
    elementary_stream.extend_from_slice(&decoder_config_descriptor);
    elementary_stream.extend_from_slice(&sl_config_descriptor);

    write_full_box(b"esds", 0, 0, descriptor(0x03, elementary_stream))
}

fn descriptor(tag: u8, payload: Vec<u8>) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(tag);
    write_descriptor_length(&mut out, payload.len());
    out.extend_from_slice(&payload);
    out
}

fn write_descriptor_length(out: &mut Vec<u8>, length: usize) {
    let mut bytes = [0_u8; 4];
    let mut value = length;
    let mut index = 3;
    bytes[index] = (value & 0x7F) as u8;
    value >>= 7;

    while value > 0 && index > 0 {
        index -= 1;
        bytes[index] = ((value & 0x7F) as u8) | 0x80;
        value >>= 7;
    }

    out.extend_from_slice(&bytes[index..]);
}

fn empty_table(name: &[u8; 4]) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 0);
    write_full_box(name, 0, 0, payload)
}

fn stsz() -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_full_box(b"stsz", 0, 0, payload)
}

fn mvex(track_ids: &[u32]) -> Vec<u8> {
    write_box(
        b"mvex",
        concat_box(track_ids.iter().map(|track_id| trex(*track_id)).collect()),
    )
}

fn trex(track_id: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, track_id);
    write_u32(&mut payload, 1);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_full_box(b"trex", 0, 0, payload)
}

fn write_matrix(out: &mut Vec<u8>) {
    write_u32(out, 0x0001_0000);
    write_u32(out, 0);
    write_u32(out, 0);
    write_u32(out, 0);
    write_u32(out, 0x0001_0000);
    write_u32(out, 0);
    write_u32(out, 0);
    write_u32(out, 0);
    write_u32(out, 0x4000_0000);
}

fn dimensions(config: &VideoCodecConfig) -> (u16, u16) {
    let (width, height) = Fmp4VideoCodec::dimensions(config);
    let width = width.unwrap_or(1).clamp(1, u16::MAX as u32) as u16;
    let height = height.unwrap_or(1).clamp(1, u16::MAX as u32) as u16;
    (width, height)
}

#[cfg(test)]
mod tests {
    use super::build_video_init_segment;
    use crate::codec::VideoCodecConfig;
    use crate::codec::av1::Av1Config;
    use crate::codec::hevc::HevcConfig;
    use crate::track::{TrackClock, TrackId, VideoTrackConfig};

    #[test]
    fn writes_hvc1_sample_entry_with_hvcc() {
        let hvcc = vec![1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 120];
        let config = VideoTrackConfig {
            id: TrackId::VIDEO,
            clock: TrackClock::new(90_000, 90_000).unwrap(),
            codec: VideoCodecConfig::Hevc(HevcConfig {
                codec_string: "hvc1.1.0.L120".to_string(),
                width: Some(1920),
                height: Some(1080),
                nal_length_size: 4,
                hvcc: hvcc.clone(),
            }),
        };

        let init_segment = build_video_init_segment(&config);

        assert!(init_segment.windows(4).any(|window| window == b"hvc1"));
        assert!(init_segment.windows(4).any(|window| window == b"hvcC"));
        assert!(
            init_segment
                .windows(hvcc.len())
                .any(|window| window == hvcc)
        );
        assert!(!init_segment.windows(4).any(|window| window == b"hev1"));
    }

    #[test]
    fn writes_av01_sample_entry_with_av1c() {
        let av1c = vec![0x81, 0x08, 0x00, 0x00];
        let config = VideoTrackConfig {
            id: TrackId::VIDEO,
            clock: TrackClock::new(90_000, 90_000).unwrap(),
            codec: VideoCodecConfig::Av1(Av1Config {
                codec_string: "av01.0.08M.08".to_string(),
                width: None,
                height: None,
                av1c: av1c.clone(),
            }),
        };

        let init_segment = build_video_init_segment(&config);

        assert!(init_segment.windows(4).any(|window| window == b"av01"));
        assert!(init_segment.windows(4).any(|window| window == b"av1C"));
        assert!(
            init_segment
                .windows(av1c.len())
                .any(|window| window == av1c)
        );
    }
}
