use crate::codec::aac::AudioConfig;
use crate::codec::avc::VideoConfig;
use crate::muxer::fmp4::boxes::{
    concat_box, write_box, write_fixed_16_16, write_full_box, write_u16, write_u32,
};

const VIDEO_TRACK_ID: u32 = 1;
const AUDIO_TRACK_ID: u32 = 2;
const VIDEO_TIMESCALE: u32 = 1000;
const AUDIO_SAMPLE_SIZE: u16 = 16;

pub fn video_timescale() -> u32 {
    VIDEO_TIMESCALE
}

pub fn build_video_init_segment(config: &VideoConfig) -> Vec<u8> {
    concat_box(vec![ftyp(&[b"avc1"]), video_moov(config)])
}

pub fn audio_timescale(config: &AudioConfig) -> u32 {
    config.sample_rate
}

pub fn build_audio_init_segment(config: &AudioConfig) -> Vec<u8> {
    concat_box(vec![ftyp(&[b"mp4a"]), audio_moov(config)])
}

pub fn build_muxed_init_segment(video_config: &VideoConfig, audio_config: &AudioConfig) -> Vec<u8> {
    concat_box(vec![
        ftyp(&[b"avc1", b"mp4a"]),
        muxed_moov(video_config, audio_config),
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

fn video_moov(config: &VideoConfig) -> Vec<u8> {
    write_box(
        b"moov",
        concat_box(vec![
            mvhd(VIDEO_TIMESCALE, VIDEO_TRACK_ID + 1),
            video_trak(config),
            mvex(&[VIDEO_TRACK_ID]),
        ]),
    )
}

fn audio_moov(config: &AudioConfig) -> Vec<u8> {
    write_box(
        b"moov",
        concat_box(vec![
            mvhd(config.sample_rate, AUDIO_TRACK_ID + 1),
            audio_trak(config),
            mvex(&[AUDIO_TRACK_ID]),
        ]),
    )
}

fn muxed_moov(video_config: &VideoConfig, audio_config: &AudioConfig) -> Vec<u8> {
    write_box(
        b"moov",
        concat_box(vec![
            mvhd(VIDEO_TIMESCALE, AUDIO_TRACK_ID + 1),
            video_trak(video_config),
            audio_trak(audio_config),
            mvex(&[VIDEO_TRACK_ID, AUDIO_TRACK_ID]),
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

fn video_trak(config: &VideoConfig) -> Vec<u8> {
    write_box(
        b"trak",
        concat_box(vec![video_tkhd(config), video_mdia(config)]),
    )
}

fn audio_trak(config: &AudioConfig) -> Vec<u8> {
    write_box(b"trak", concat_box(vec![audio_tkhd(), audio_mdia(config)]))
}

fn video_tkhd(config: &VideoConfig) -> Vec<u8> {
    let (width, height) = dimensions(config);
    let mut payload = Vec::new();
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, VIDEO_TRACK_ID);
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

fn audio_tkhd() -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, AUDIO_TRACK_ID);
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

fn video_mdia(config: &VideoConfig) -> Vec<u8> {
    write_box(
        b"mdia",
        concat_box(vec![
            mdhd(VIDEO_TIMESCALE),
            video_hdlr(),
            video_minf(config),
        ]),
    )
}

fn audio_mdia(config: &AudioConfig) -> Vec<u8> {
    write_box(
        b"mdia",
        concat_box(vec![
            mdhd(config.sample_rate),
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

fn video_minf(config: &VideoConfig) -> Vec<u8> {
    write_box(
        b"minf",
        concat_box(vec![vmhd(), dinf(), video_stbl(config)]),
    )
}

fn audio_minf(config: &AudioConfig) -> Vec<u8> {
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

fn video_stbl(config: &VideoConfig) -> Vec<u8> {
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

fn audio_stbl(config: &AudioConfig) -> Vec<u8> {
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

fn video_stsd(config: &VideoConfig) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 1);
    payload.extend_from_slice(&avc1(config));
    write_full_box(b"stsd", 0, 0, payload)
}

fn audio_stsd(config: &AudioConfig) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 1);
    payload.extend_from_slice(&mp4a(config));
    write_full_box(b"stsd", 0, 0, payload)
}

fn avc1(config: &VideoConfig) -> Vec<u8> {
    let (width, height) = dimensions(config);
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
    payload.extend_from_slice(&write_box(b"avcC", config.avcc.clone()));
    write_box(b"avc1", payload)
}

fn mp4a(config: &AudioConfig) -> Vec<u8> {
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

fn esds(config: &AudioConfig) -> Vec<u8> {
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

fn dimensions(config: &VideoConfig) -> (u16, u16) {
    let width = config.width.unwrap_or(1).clamp(1, u16::MAX as u32) as u16;
    let height = config.height.unwrap_or(1).clamp(1, u16::MAX as u32) as u16;
    (width, height)
}
