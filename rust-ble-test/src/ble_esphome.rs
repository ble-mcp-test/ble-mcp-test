//! ESPHome native-API backend: talks to a Bluetooth Proxy over TCP (no local radio).
//!
//! The `esphome-native-api` crate is responder-only, so we reuse only its `proto` structs and
//! `parser` codec and hand-write the client here: plaintext framing (`esphome_proto`) + the
//! initiator handshake (Hello → Auth) + the Bluetooth-proxy active-connection flow
//! (connect-by-address → get-services → subscribe-notify → write-without-response) + keepalive
//! pings + reconnect-on-drop (the keep-warm session persistence).
//!
//! Noise/PSK encryption is a documented follow-up; `new()` rejects a configured PSK.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use esphome_native_api::parser::{self, ProtoMessage};
use esphome_native_api::proto::{
    AuthenticationRequest, BluetoothDeviceRequest, BluetoothDeviceRequestType, BluetoothGattGetServicesRequest,
    BluetoothGattNotifyRequest, BluetoothGattService, BluetoothGattWriteDescriptorRequest, BluetoothGattWriteRequest,
    DisconnectRequest, HelloRequest, PingRequest, PingResponse, SubscribeBluetoothLeAdvertisementsRequest,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, Mutex};

use crate::config::Config;
use crate::esphome_proto::{self, decode_frame, encode_frame};
use crate::transport::{BleTransport, NotifyRx, TransportError};

/// Shared, reference-counted state so the read/reconnect task and `write()` share one socket.
struct Inner {
    host: String,
    port: u16,
    address: u64,
    write_short: u16,
    notify_short: u16,
    tx: broadcast::Sender<Vec<u8>>,
    writer: Mutex<Option<OwnedWriteHalf>>,
    write_handle: AtomicU32,
    connected: AtomicBool,
}

pub struct EsphomeTransport {
    inner: Arc<Inner>,
}

/// Encode a message into a full plaintext frame using the crate's codec + our framing.
fn frame_for(msg: &ProtoMessage) -> Vec<u8> {
    let ty = parser::message_to_num(msg).expect("known message type");
    let payload = parser::proto_to_vec(msg).expect("encodable message");
    encode_frame(ty, &payload)
}

/// Send one message.
async fn send<W: AsyncWriteExt + Unpin>(w: &mut W, msg: &ProtoMessage) -> Result<(), TransportError> {
    let frame = frame_for(msg);
    w.write_all(&frame)
        .await
        .map_err(|e| TransportError::Write(format!("send: {e}")))?;
    // Flush is required: without it the small handshake frames sit in the TCP buffer and the
    // proxy never responds (this cost hours to find).
    w.flush().await.map_err(|e| TransportError::Write(format!("flush: {e}")))
}

/// Read the next decodable message, buffering across reads. Unknown message types are skipped.
async fn recv<R: AsyncReadExt + Unpin>(
    r: &mut R,
    buf: &mut Vec<u8>,
) -> Result<ProtoMessage, TransportError> {
    loop {
        match decode_frame(buf) {
            Ok(Some((ty, payload, consumed))) => {
                buf.drain(..consumed);
                match parser::parse_proto_message(ty as usize, &payload) {
                    Ok(msg) => return Ok(msg),
                    Err(_) => continue, // unknown/undecodable type; skip
                }
            }
            Ok(None) => {}
            Err(e) => return Err(TransportError::Other(format!("frame decode: {e}"))),
        }
        let mut chunk = [0u8; 4096];
        let n = r
            .read(&mut chunk)
            .await
            .map_err(|e| TransportError::Connect(format!("read: {e}")))?;
        if n == 0 {
            return Err(TransportError::Connect("proxy closed connection".into()));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

impl Inner {
    /// TCP connect + full handshake + BT active connection + notify subscribe.
    /// On success: stores the write half + write handle, marks connected, and returns the read
    /// half (plus any buffered bytes) and the notify handle for the read loop.
    async fn establish(self: &Arc<Self>) -> Result<(OwnedReadHalf, Vec<u8>, u32), TransportError> {
        let mut stream = TcpStream::connect((self.host.as_str(), self.port))
            .await
            .map_err(|e| TransportError::Connect(format!("tcp {}:{}: {e}", self.host, self.port)))?;
        let mut buf = Vec::new();
        println!("(esphome) TCP connected to proxy {}:{}", self.host, self.port);

        // 1) Hello.
        send(
            &mut stream,
            &ProtoMessage::HelloRequest(HelloRequest {
                client_info: "ble-mcp-test-rust".into(),
                api_version_major: 1,
                api_version_minor: 10,
            }),
        )
        .await?;
        loop {
            match recv(&mut stream, &mut buf).await? {
                ProtoMessage::HelloResponse(_) => break,
                ProtoMessage::PingRequest(_) => {
                    send(&mut stream, &ProtoMessage::PingResponse(PingResponse {})).await?
                }
                _ => {}
            }
        }

        // 2) Connect/Auth, fire-and-forget. With no API password configured (our case) the proxy
        // sends NO response to this — verified against ESPHome 2026.8.0: aioesphomeapi likewise
        // sends AuthenticationRequest and treats the handshake as complete on HelloResponse alone.
        // Waiting for a response here would hang. A wrong password surfaces as the server closing
        // the link on the next exchange (recv → EOF error).
        send(
            &mut stream,
            &ProtoMessage::AuthenticationRequest(AuthenticationRequest {
                password: String::new(),
            }),
        )
        .await?;

        println!("(esphome) native-API handshake complete");

        // 2b) Subscribe to LE advertisements and wait to hear the target. The proxy's scanner must
        // have seen the device before an active connection by address will complete (matches the
        // aioesphomeapi scan-then-connect flow).
        send(
            &mut stream,
            &ProtoMessage::SubscribeBluetoothLeAdvertisementsRequest(
                SubscribeBluetoothLeAdvertisementsRequest { flags: 1 },
            ),
        )
        .await?;
        // Capture the device's advertised address_type — the proxy needs it to connect (the CS108
        // uses a random address, type 1; omitting it makes the connect silently fail).
        let dev_address_type: u32 = {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
            loop {
                if tokio::time::Instant::now() >= deadline {
                    return Err(TransportError::Connect(format!(
                        "device {:012X} not heard advertising to the proxy within 30s",
                        self.address
                    )));
                }
                match tokio::time::timeout(Duration::from_secs(5), recv(&mut stream, &mut buf)).await {
                    Ok(Ok(ProtoMessage::BluetoothLeRawAdvertisementsResponse(r))) => {
                        if let Some(a) = r.advertisements.iter().find(|a| a.address == self.address) {
                            break a.address_type;
                        }
                    }
                    Ok(Ok(ProtoMessage::PingRequest(_))) => {
                        send(&mut stream, &ProtoMessage::PingResponse(PingResponse {})).await?
                    }
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => return Err(e),
                    Err(_) => {} // recv timeout tick; re-check the deadline
                }
            }
        };
        println!(
            "(esphome) heard target advertising (address_type={}); requesting BLE connection to {:012X}",
            dev_address_type, self.address
        );

        // 3) BLE active connection by address, carrying the advertised address_type.
        send(
            &mut stream,
            &ProtoMessage::BluetoothDeviceRequest(BluetoothDeviceRequest {
                address: self.address,
                request_type: BluetoothDeviceRequestType::ConnectV3WithoutCache as i32,
                has_address_type: true,
                address_type: dev_address_type,
            }),
        )
        .await?;
        {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
            loop {
                if tokio::time::Instant::now() >= deadline {
                    return Err(TransportError::Connect(format!(
                        "device {:012X} connect timed out",
                        self.address
                    )));
                }
                match tokio::time::timeout(Duration::from_secs(5), recv(&mut stream, &mut buf)).await {
                    Ok(Ok(ProtoMessage::BluetoothDeviceConnectionResponse(r)))
                        if r.address == self.address =>
                    {
                        if r.connected {
                            println!("(proxy) BLE device connected, mtu={}", r.mtu);
                            break;
                        } else if r.error != 0 {
                            return Err(TransportError::Connect(format!(
                                "proxy failed to connect device (error={})",
                                r.error
                            )));
                        }
                        // connected=false, error=0: transient/in-progress; keep waiting.
                    }
                    Ok(Ok(ProtoMessage::PingRequest(_))) => {
                        send(&mut stream, &ProtoMessage::PingResponse(PingResponse {})).await?
                    }
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => return Err(e),
                    Err(_) => {}
                }
            }
        }

        // 4) Discover services.
        send(
            &mut stream,
            &ProtoMessage::BluetoothGattGetServicesRequest(BluetoothGattGetServicesRequest {
                address: self.address,
            }),
        )
        .await?;
        let mut services: Vec<BluetoothGattService> = Vec::new();
        loop {
            match recv(&mut stream, &mut buf).await? {
                ProtoMessage::BluetoothGattGetServicesResponse(r) if r.address == self.address => {
                    services.extend(r.services);
                }
                ProtoMessage::BluetoothGattGetServicesDoneResponse(r) if r.address == self.address => {
                    break
                }
                ProtoMessage::BluetoothGattErrorResponse(e) => {
                    return Err(TransportError::Connect(format!(
                        "gatt error during get-services: handle={} error={}",
                        e.handle, e.error
                    )));
                }
                ProtoMessage::PingRequest(_) => {
                    send(&mut stream, &ProtoMessage::PingResponse(PingResponse {})).await?
                }
                _ => {}
            }
        }

        let write_handle = esphome_proto::find_char_handle(&services, self.write_short).ok_or_else(|| {
            TransportError::Connect(format!("write characteristic {:#06x} not found", self.write_short))
        })?;
        let notify_handle = esphome_proto::find_char_handle(&services, self.notify_short).ok_or_else(|| {
            TransportError::Connect(format!("notify characteristic {:#06x} not found", self.notify_short))
        })?;
        let cccd_handle = esphome_proto::find_cccd_handle(&services, self.notify_short);
        println!(
            "(esphome) discovered {} services; write=handle {} notify=handle {} cccd=handle {:?}",
            services.len(),
            write_handle,
            notify_handle,
            cccd_handle
        );

        // 5) Enable notifications: tell the proxy to forward them (NotifyRequest), then write the
        // CCCD (0x2902) descriptor = 0x0001 to actually turn them on at the device — both are
        // required (verified against the aioesphomeapi flow).
        send(
            &mut stream,
            &ProtoMessage::BluetoothGattNotifyRequest(BluetoothGattNotifyRequest {
                address: self.address,
                handle: notify_handle,
                enable: true,
            }),
        )
        .await?;
        loop {
            match recv(&mut stream, &mut buf).await? {
                ProtoMessage::BluetoothGattNotifyResponse(r)
                    if r.address == self.address && r.handle == notify_handle =>
                {
                    break
                }
                ProtoMessage::BluetoothGattErrorResponse(e) => {
                    return Err(TransportError::Connect(format!(
                        "gatt error subscribing notify: handle={} error={}",
                        e.handle, e.error
                    )));
                }
                ProtoMessage::PingRequest(_) => {
                    send(&mut stream, &ProtoMessage::PingResponse(PingResponse {})).await?
                }
                _ => {}
            }
        }
        if let Some(cccd) = cccd_handle {
            send(
                &mut stream,
                &ProtoMessage::BluetoothGattWriteDescriptorRequest(BluetoothGattWriteDescriptorRequest {
                    address: self.address,
                    handle: cccd,
                    data: vec![0x01, 0x00],
                }),
            )
            .await?;
            loop {
                match recv(&mut stream, &mut buf).await? {
                    ProtoMessage::BluetoothGattWriteResponse(r)
                        if r.address == self.address && r.handle == cccd =>
                    {
                        break
                    }
                    ProtoMessage::BluetoothGattErrorResponse(e) => {
                        return Err(TransportError::Connect(format!(
                            "gatt error writing CCCD: handle={} error={}",
                            e.handle, e.error
                        )));
                    }
                    ProtoMessage::PingRequest(_) => {
                        send(&mut stream, &ProtoMessage::PingResponse(PingResponse {})).await?
                    }
                    _ => {}
                }
            }
        } else {
            println!(
                "(esphome) WARNING: no CCCD (0x2902) under notify char {:#06x}; notifications may not flow",
                self.notify_short
            );
        }

        println!("✅ Connected on attempt 1");
        self.write_handle.store(write_handle, Ordering::SeqCst);

        let (read_half, write_half) = stream.into_split();
        *self.writer.lock().await = Some(write_half);
        self.connected.store(true, Ordering::SeqCst);

        Ok((read_half, buf, notify_handle))
    }

    /// Run one session: forward notifications, answer pings, keepalive, until the link drops.
    async fn read_loop(self: &Arc<Self>, mut read_half: OwnedReadHalf, mut buf: Vec<u8>, notify_handle: u32) {
        let mut ping = tokio::time::interval(Duration::from_secs(20));
        ping.tick().await; // consume the immediate first tick

        loop {
            // Drain every complete frame currently buffered.
            loop {
                match decode_frame(&buf) {
                    Ok(Some((ty, payload, consumed))) => {
                        buf.drain(..consumed);
                        let Ok(msg) = parser::parse_proto_message(ty as usize, &payload) else {
                            continue;
                        };
                        match msg {
                            ProtoMessage::BluetoothGattNotifyDataResponse(n)
                                if n.address == self.address && n.handle == notify_handle =>
                            {
                                println!("📥 BLE notification: {:02X?}", n.data);
                                let _ = self.tx.send(n.data);
                            }
                            ProtoMessage::PingRequest(_) => {
                                let frame = frame_for(&ProtoMessage::PingResponse(PingResponse {}));
                                if let Some(w) = self.writer.lock().await.as_mut() {
                                    let _ = w.write_all(&frame).await;
                                }
                            }
                            ProtoMessage::BluetoothDeviceConnectionResponse(r)
                                if r.address == self.address && !r.connected =>
                            {
                                println!("🔌 proxy reported BLE disconnect (error={})", r.error);
                                self.connected.store(false, Ordering::SeqCst);
                                return;
                            }
                            ProtoMessage::DisconnectRequest(_) => {
                                println!("🔌 proxy requested API disconnect");
                                self.connected.store(false, Ordering::SeqCst);
                                return;
                            }
                            ProtoMessage::BluetoothGattErrorResponse(e) => {
                                println!("⚠️  gatt error: handle={} error={}", e.handle, e.error);
                            }
                            _ => {}
                        }
                    }
                    Ok(None) => break,
                    Err(_) => {
                        buf.clear(); // unrecoverable framing desync; resync on next read
                        break;
                    }
                }
            }

            let mut chunk = [0u8; 4096];
            tokio::select! {
                r = read_half.read(&mut chunk) => match r {
                    Ok(0) => {
                        println!("🔌 proxy closed API connection");
                        self.connected.store(false, Ordering::SeqCst);
                        return;
                    }
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    Err(e) => {
                        println!("🔌 API read error: {e}");
                        self.connected.store(false, Ordering::SeqCst);
                        return;
                    }
                },
                _ = ping.tick() => {
                    let frame = frame_for(&ProtoMessage::PingRequest(PingRequest {}));
                    let mut g = self.writer.lock().await;
                    let ok = match g.as_mut() {
                        Some(w) => w.write_all(&frame).await.is_ok(),
                        None => false,
                    };
                    if !ok {
                        self.connected.store(false, Ordering::SeqCst);
                        return;
                    }
                }
            }
        }
    }
}

impl EsphomeTransport {
    pub fn new(cfg: &Config) -> Result<Self, TransportError> {
        if cfg.esphome_psk.is_some() {
            return Err(TransportError::Other(
                "Noise PSK not yet supported; use a plaintext ESPHome proxy (ESPHOME_NOISE_PSK unset)"
                    .to_string(),
            ));
        }
        let address = esphome_proto::mac_to_u64(&cfg.device_mac)
            .map_err(|e| TransportError::Other(format!("device mac: {e}")))?;
        Ok(Self {
            inner: Arc::new(Inner {
                host: cfg.esphome_host.clone(),
                port: cfg.esphome_port,
                address,
                write_short: (cfg.write_uuid.as_u128() >> 96) as u16,
                notify_short: (cfg.notify_uuid.as_u128() >> 96) as u16,
                tx: broadcast::channel(256).0,
                writer: Mutex::new(None),
                write_handle: AtomicU32::new(0),
                connected: AtomicBool::new(false),
            }),
        })
    }
}

#[async_trait]
impl BleTransport for EsphomeTransport {
    async fn connect(&self) -> Result<(), TransportError> {
        // Initial connect must succeed (mirrors btleplug: a failed bring-up exits for PM2 restart).
        let (read_half, buf, notify_handle) = self.inner.establish().await?;

        // Supervisor: run the session, and on drop reconnect with backoff (keep-warm persistence).
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let (mut rh, mut b, mut nh) = (read_half, buf, notify_handle);
            loop {
                inner.read_loop(rh, b, nh).await;
                let mut delay = Duration::from_secs(2);
                loop {
                    tokio::time::sleep(delay).await;
                    match inner.establish().await {
                        Ok((r, bb, n)) => {
                            println!("🔄 esphome reconnected");
                            rh = r;
                            b = bb;
                            nh = n;
                            break;
                        }
                        Err(e) => {
                            println!("🔄 esphome reconnect failed: {e}");
                            delay = (delay * 2).min(Duration::from_secs(30));
                        }
                    }
                }
            }
        });
        Ok(())
    }

    async fn write(&self, data: &[u8]) -> Result<(), TransportError> {
        if !self.inner.connected.load(Ordering::SeqCst) {
            return Err(TransportError::NotConnected);
        }
        let msg = ProtoMessage::BluetoothGattWriteRequest(BluetoothGattWriteRequest {
            address: self.inner.address,
            handle: self.inner.write_handle.load(Ordering::SeqCst),
            response: false, // write-without-response
            data: data.to_vec(),
        });
        let frame = frame_for(&msg);
        let mut g = self.inner.writer.lock().await;
        match g.as_mut() {
            Some(w) => {
                w.write_all(&frame)
                    .await
                    .map_err(|e| TransportError::Write(format!("gatt write: {e}")))?;
                println!("📤 BLE write successful: {:02X?}", data);
                Ok(())
            }
            None => Err(TransportError::NotConnected),
        }
    }

    async fn disconnect(&self) -> Result<(), TransportError> {
        self.inner.connected.store(false, Ordering::SeqCst);
        let mut g = self.inner.writer.lock().await;
        if let Some(w) = g.as_mut() {
            let disc = frame_for(&ProtoMessage::BluetoothDeviceRequest(BluetoothDeviceRequest {
                address: self.inner.address,
                request_type: BluetoothDeviceRequestType::Disconnect as i32,
                ..Default::default()
            }));
            let _ = w.write_all(&disc).await;
            let bye = frame_for(&ProtoMessage::DisconnectRequest(DisconnectRequest {}));
            let _ = w.write_all(&bye).await;
        }
        *g = None;
        Ok(())
    }

    fn subscribe(&self) -> NotifyRx {
        self.inner.tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use esphome_native_api::proto::HelloRequest;

    #[test]
    fn hello_frames_and_parses_back() {
        let msg = ProtoMessage::HelloRequest(HelloRequest {
            client_info: "x".into(),
            api_version_major: 1,
            api_version_minor: 10,
        });
        let frame = frame_for(&msg);
        let (ty, payload, _) = crate::esphome_proto::decode_frame(&frame).unwrap().unwrap();
        assert_eq!(ty, 1);
        let back = parser::parse_proto_message(ty as usize, &payload).unwrap();
        assert!(matches!(back, ProtoMessage::HelloRequest(_)));
    }
}
