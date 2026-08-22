//! ESPHome native-API wire layer: plaintext framing, MAC/UUID helpers.
//!
//! Plaintext frame = `0x00 <varint payload_len> <varint msg_type> <payload>`. (Noise-encrypted
//! framing is a documented follow-up; the bench proxy runs plaintext.)

/// Error decoding a plaintext frame.
#[derive(thiserror::Error, Debug, PartialEq, Eq)]
pub enum FrameDecodeError {
    #[error("bad preamble byte {0:#x}")]
    BadPreamble(u8),
}

/// Append a base-128 varint (protobuf-style) to `out`.
pub fn write_varint(mut v: u64, out: &mut Vec<u8>) {
    loop {
        let mut byte = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if v == 0 {
            break;
        }
    }
}

/// Read a base-128 varint from the front of `buf`. Returns `(value, bytes_read)`, or `None`
/// if the buffer ends mid-varint (needs more bytes) or the varint overflows 64 bits.
pub fn read_varint(buf: &[u8]) -> Option<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    for (i, &byte) in buf.iter().enumerate() {
        if shift >= 64 {
            return None; // malformed / overflow
        }
        result |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some((result, i + 1));
        }
        shift += 7;
    }
    None // incomplete
}

/// Encode one plaintext frame: `0x00`, varint(payload_len), varint(msg_type), payload.
pub fn encode_frame(msg_type: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 4);
    out.push(0x00);
    write_varint(payload.len() as u64, &mut out);
    write_varint(msg_type as u64, &mut out);
    out.extend_from_slice(payload);
    out
}

/// Try to decode one frame from the front of `buf`.
///
/// `Ok(Some((msg_type, payload, consumed)))` when a whole frame is present; `Ok(None)` when more
/// bytes are needed; `Err` on a malformed preamble byte.
pub fn decode_frame(buf: &[u8]) -> Result<Option<(u32, Vec<u8>, usize)>, FrameDecodeError> {
    if buf.is_empty() {
        return Ok(None);
    }
    if buf[0] != 0x00 {
        return Err(FrameDecodeError::BadPreamble(buf[0]));
    }
    let (len, len_bytes) = match read_varint(&buf[1..]) {
        Some(x) => x,
        None => return Ok(None),
    };
    let after_len = 1 + len_bytes;
    let (msg_type, type_bytes) = match read_varint(&buf[after_len..]) {
        Some(x) => x,
        None => return Ok(None),
    };
    let header = after_len + type_bytes;
    let total = header + len as usize;
    if buf.len() < total {
        return Ok(None);
    }
    Ok(Some((msg_type as u32, buf[header..total].to_vec(), total)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_roundtrip() {
        for v in [0u64, 1, 127, 128, 300, 16384, 1_000_000] {
            let mut b = vec![];
            write_varint(v, &mut b);
            assert_eq!(read_varint(&b), Some((v, b.len())));
        }
    }

    #[test]
    fn encode_hello_frame_shape() {
        assert_eq!(encode_frame(1, &[]), vec![0x00, 0x00, 0x01]);
    }

    #[test]
    fn encode_then_decode() {
        let payload = vec![0xDE, 0xAD, 0xBE, 0xEF];
        let frame = encode_frame(79, &payload); // BluetoothGattNotifyDataResponse
        let (ty, got, consumed) = decode_frame(&frame).unwrap().unwrap();
        assert_eq!(ty, 79);
        assert_eq!(got, payload);
        assert_eq!(consumed, frame.len());
    }

    #[test]
    fn decode_partial_returns_none() {
        let frame = encode_frame(79, &[1, 2, 3, 4, 5]);
        assert!(decode_frame(&frame[..2]).unwrap().is_none());
        assert!(decode_frame(&frame[..frame.len() - 1]).unwrap().is_none());
    }

    #[test]
    fn decode_two_frames_in_stream() {
        let mut s = encode_frame(8, &[]); // PingResponse
        s.extend(encode_frame(79, &[0xAA]));
        let (t1, _, c1) = decode_frame(&s).unwrap().unwrap();
        assert_eq!(t1, 8);
        let (t2, p2, _) = decode_frame(&s[c1..]).unwrap().unwrap();
        assert_eq!((t2, p2), (79, vec![0xAA]));
    }

    #[test]
    fn bad_preamble_errors() {
        assert_eq!(
            decode_frame(&[0x01, 0x00, 0x01]),
            Err(FrameDecodeError::BadPreamble(0x01))
        );
    }

    #[test]
    fn large_payload_multibyte_len_varint() {
        let payload = vec![0x5A; 300]; // len 300 => 2-byte varint
        let frame = encode_frame(71, &payload);
        let (ty, got, consumed) = decode_frame(&frame).unwrap().unwrap();
        assert_eq!(ty, 71);
        assert_eq!(got.len(), 300);
        assert_eq!(consumed, frame.len());
    }
}
