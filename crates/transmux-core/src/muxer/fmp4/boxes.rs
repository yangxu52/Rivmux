pub(super) fn write_u8(out: &mut Vec<u8>, value: u8) {
    out.push(value);
}

pub(super) fn write_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_be_bytes());
}

pub(super) fn write_i32(out: &mut Vec<u8>, value: i32) {
    out.extend_from_slice(&value.to_be_bytes());
}

pub(super) fn write_u24(out: &mut Vec<u8>, value: u32) {
    out.push(((value >> 16) & 0xFF) as u8);
    out.push(((value >> 8) & 0xFF) as u8);
    out.push((value & 0xFF) as u8);
}

pub(super) fn write_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}

pub(super) fn write_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_be_bytes());
}

pub(super) fn write_fixed_16_16(out: &mut Vec<u8>, value: u16) {
    write_u32(out, (value as u32) << 16);
}

pub(super) fn write_box(name: &[u8; 4], payload: Vec<u8>) -> Vec<u8> {
    let size = 8 + payload.len();
    let mut out = Vec::with_capacity(size);
    write_u32(&mut out, size as u32);
    out.extend_from_slice(name);
    out.extend_from_slice(&payload);
    out
}

pub(super) fn write_full_box(name: &[u8; 4], version: u8, flags: u32, payload: Vec<u8>) -> Vec<u8> {
    let mut full_payload = Vec::with_capacity(4 + payload.len());
    write_u8(&mut full_payload, version);
    write_u24(&mut full_payload, flags);
    full_payload.extend_from_slice(&payload);
    write_box(name, full_payload)
}

pub(super) fn concat_box(children: Vec<Vec<u8>>) -> Vec<u8> {
    let total = children.iter().map(Vec::len).sum();
    let mut out = Vec::with_capacity(total);
    for child in children {
        out.extend_from_slice(&child);
    }
    out
}
