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

use esphome_native_api::proto::BluetoothGattService;

/// Low 64 bits of the Bluetooth base UUID `...-8000-00805f9b34fb`.
const BASE_UUID_LOW: u64 = 0x8000_0080_5f9b_34fb;

/// Pack a `"6C:79:B8:XX:XX:XX"` MAC into the `u64` address the ESPHome proxy uses (big-endian, low 48 bits).
pub fn mac_to_u64(mac: &str) -> Result<u64, String> {
    let parts: Vec<&str> = mac.split(':').collect();
    if parts.len() != 6 {
        return Err(format!("expected 6 colon-separated octets, got '{mac}'"));
    }
    let mut out: u64 = 0;
    for p in parts {
        let byte = u8::from_str_radix(p, 16).map_err(|_| format!("bad octet '{p}' in '{mac}'"))?;
        out = (out << 8) | byte as u64;
    }
    Ok(out)
}

/// Find the GATT `handle` for a 16-bit characteristic UUID across the proxy's service list.
///
/// The proxy may report a characteristic's UUID either as `short_uuid: u32` (16/32-bit) or as a
/// 128-bit `uuid: Vec<u64>` (`[high, low]`). For a 16-bit UUID `xxxx` in the Bluetooth base UUID,
/// `high = 0x0000_xxxx_0000_1000`, `low = 0x8000_0080_5f9b_34fb`.
///
/// NOTE: the 128-bit `[high, low]` byte order is verified against a live `GetServicesResponse` in
/// Task 8; if the proxy differs, adjust this and the matching test together.
pub fn find_char_handle(services: &[BluetoothGattService], short_uuid: u16) -> Option<u32> {
    let want_high: u64 = 0x0000_0000_0000_1000 | ((short_uuid as u64) << 32);
    for svc in services {
        for ch in &svc.characteristics {
            if ch.short_uuid == short_uuid as u32 {
                return Some(ch.handle);
            }
            if ch.uuid.len() == 2 && ch.uuid[0] == want_high && ch.uuid[1] == BASE_UUID_LOW {
                return Some(ch.handle);
            }
        }
    }
    None
}

/// 16-bit UUID of the Client Characteristic Configuration Descriptor (CCCD).
const CCCD_SHORT: u16 = 0x2902;

/// Find the CCCD (0x2902) descriptor handle under the characteristic with `char_short` UUID.
/// Writing `[0x01, 0x00]` to it is what actually enables notifications on the device.
pub fn find_cccd_handle(services: &[BluetoothGattService], char_short: u16) -> Option<u32> {
    let want_char_high: u64 = 0x0000_0000_0000_1000 | ((char_short as u64) << 32);
    let want_cccd_high: u64 = 0x0000_0000_0000_1000 | ((CCCD_SHORT as u64) << 32);
    for svc in services {
        for ch in &svc.characteristics {
            let is_target = ch.short_uuid == char_short as u32
                || (ch.uuid.len() == 2 && ch.uuid[0] == want_char_high && ch.uuid[1] == BASE_UUID_LOW);
            if !is_target {
                continue;
            }
            for d in &ch.descriptors {
                if d.short_uuid == CCCD_SHORT as u32
                    || (d.uuid.len() == 2 && d.uuid[0] == want_cccd_high && d.uuid[1] == BASE_UUID_LOW)
                {
                    return Some(d.handle);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod uuid_tests {
    use super::*;
    use esphome_native_api::proto::{
        BluetoothGattCharacteristic, BluetoothGattDescriptor, BluetoothGattService,
    };

    #[test]
    fn finds_cccd_handle_under_notify_char() {
        let svc = BluetoothGattService {
            characteristics: vec![BluetoothGattCharacteristic {
                handle: 20,
                short_uuid: 0x9901,
                descriptors: vec![BluetoothGattDescriptor {
                    handle: 21,
                    short_uuid: 0x2902,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(find_cccd_handle(&[svc], 0x9901), Some(21));
    }

    #[test]
    fn mac_packs_big_endian_low48() {
        assert_eq!(mac_to_u64("AA:BB:CC:DD:EE:FF").unwrap(), 0xAABBCCDDEEFF);
    }
    #[test]
    fn mac_rejects_garbage() {
        assert!(mac_to_u64("nope").is_err());
    }
    #[test]
    fn mac_rejects_bad_octet() {
        assert!(mac_to_u64("6C:79:B8:XX:XX:ZZ").is_err());
    }

    #[test]
    fn finds_handle_by_short_uuid() {
        let svc = BluetoothGattService {
            characteristics: vec![
                BluetoothGattCharacteristic {
                    handle: 42,
                    short_uuid: 0x9900,
                    ..Default::default()
                },
                BluetoothGattCharacteristic {
                    handle: 43,
                    short_uuid: 0x9901,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert_eq!(find_char_handle(&[svc], 0x9900), Some(42));
    }

    #[test]
    fn finds_handle_by_128bit_pair() {
        let svc = BluetoothGattService {
            characteristics: vec![BluetoothGattCharacteristic {
                handle: 99,
                uuid: vec![0x0000_9901_0000_1000, 0x8000_0080_5f9b_34fb],
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(find_char_handle(&[svc], 0x9901), Some(99));
    }

    #[test]
    fn no_match_returns_none() {
        let svc = BluetoothGattService {
            characteristics: vec![BluetoothGattCharacteristic {
                handle: 1,
                short_uuid: 0x2a00,
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(find_char_handle(&[svc], 0x9900), None);
    }
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
