use crate::codec::avc::VideoConfig;
use crate::mux::fmp4::boxes::{
    concat_box, write_box, write_fixed_16_16, write_full_box, write_u16, write_u32,
};

const VIDEO_TRACK_ID: u32 = 1;
const VIDEO_TIMESCALE: u32 = 1000;

pub fn video_timescale() -> u32 {
    VIDEO_TIMESCALE
}

pub fn build_video_init_segment(config: &VideoConfig) -> Vec<u8> {
    concat_box(vec![ftyp(), moov(config)])
}

fn ftyp() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(b"iso6");
    write_u32(&mut payload, 1);
    payload.extend_from_slice(b"iso6");
    payload.extend_from_slice(b"mp41");
    payload.extend_from_slice(b"avc1");
    payload.extend_from_slice(b"dash");
    write_box(b"ftyp", payload)
}

fn moov(config: &VideoConfig) -> Vec<u8> {
    write_box(b"moov", concat_box(vec![mvhd(), trak(config), mvex()]))
}

fn mvhd() -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, VIDEO_TIMESCALE);
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
    write_u32(&mut payload, VIDEO_TRACK_ID + 1);
    write_full_box(b"mvhd", 0, 0, payload)
}

fn trak(config: &VideoConfig) -> Vec<u8> {
    write_box(b"trak", concat_box(vec![tkhd(config), mdia(config)]))
}

fn tkhd(config: &VideoConfig) -> Vec<u8> {
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

fn mdia(config: &VideoConfig) -> Vec<u8> {
    write_box(b"mdia", concat_box(vec![mdhd(), hdlr(), minf(config)]))
}

fn mdhd() -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, VIDEO_TIMESCALE);
    write_u32(&mut payload, 0);
    write_u16(&mut payload, 0x55C4);
    write_u16(&mut payload, 0);
    write_full_box(b"mdhd", 0, 0, payload)
}

fn hdlr() -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 0);
    payload.extend_from_slice(b"vide");
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    write_u32(&mut payload, 0);
    payload.extend_from_slice(b"VideoHandler\0");
    write_full_box(b"hdlr", 0, 0, payload)
}

fn minf(config: &VideoConfig) -> Vec<u8> {
    write_box(b"minf", concat_box(vec![vmhd(), dinf(), stbl(config)]))
}

fn vmhd() -> Vec<u8> {
    let mut payload = Vec::new();
    write_u16(&mut payload, 0);
    write_u16(&mut payload, 0);
    write_u16(&mut payload, 0);
    write_u16(&mut payload, 0);
    write_full_box(b"vmhd", 0, 1, payload)
}

fn dinf() -> Vec<u8> {
    let mut dref_payload = Vec::new();
    write_u32(&mut dref_payload, 1);
    dref_payload.extend_from_slice(&write_full_box(b"url ", 0, 1, Vec::new()));
    write_box(b"dinf", write_full_box(b"dref", 0, 0, dref_payload))
}

fn stbl(config: &VideoConfig) -> Vec<u8> {
    write_box(
        b"stbl",
        concat_box(vec![
            stsd(config),
            empty_table(b"stts"),
            empty_table(b"stsc"),
            stsz(),
            empty_table(b"stco"),
        ]),
    )
}

fn stsd(config: &VideoConfig) -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, 1);
    payload.extend_from_slice(&avc1(config));
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

fn mvex() -> Vec<u8> {
    write_box(b"mvex", trex())
}

fn trex() -> Vec<u8> {
    let mut payload = Vec::new();
    write_u32(&mut payload, VIDEO_TRACK_ID);
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
