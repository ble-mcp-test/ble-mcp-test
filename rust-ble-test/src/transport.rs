//! The `BleTransport` trait and backend factory.
//!
//! `main.rs` drives an `Arc<dyn BleTransport>` chosen by config, staying agnostic to whether
//! the bytes travel over a local radio (btleplug) or an ESPHome proxy (esphome).

use async_trait::async_trait;
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::config::{Backend, Config};

/// A receiver of raw notification payloads. One item per BLE notification — boundaries preserved.
pub type NotifyRx = broadcast::Receiver<Vec<u8>>;

/// Errors surfaced by a backend.
#[derive(thiserror::Error, Debug)]
pub enum TransportError {
    #[error("not connected")]
    NotConnected,
    #[error("connect failed: {0}")]
    Connect(String),
    #[error("write failed: {0}")]
    Write(String),
    #[error("{0}")]
    Other(String),
}

/// Abstraction over a BLE link to the target device, implemented by each backend.
///
/// Methods take `&self` (interior mutability inside each impl) so the transport can be shared
/// across the WS-accept task and the serialized command task via `Arc`.
#[async_trait]
pub trait BleTransport: Send + Sync {
    /// Find + connect + discover + subscribe-notify. Called once at startup; re-entrant on reconnect.
    async fn connect(&self) -> Result<(), TransportError>;
    /// Write-without-response. The caller serializes writes.
    async fn write(&self, data: &[u8]) -> Result<(), TransportError>;
    /// Tear down the link.
    async fn disconnect(&self) -> Result<(), TransportError>;
    /// Whether a live link currently exists.
    async fn is_connected(&self) -> bool;
    /// A fresh receiver of raw notification payloads (one item per BLE notification).
    fn subscribe(&self) -> NotifyRx;
}

/// Construct the backend chosen by `cfg`.
///
/// Does NOT connect. For the esphome backend it never constructs a btleplug `Manager`
/// (no BlueZ/D-Bus initialization) — the network link is opened later in `connect()`.
pub async fn build(cfg: &Config) -> Result<Arc<dyn BleTransport>, TransportError> {
    match cfg.backend {
        Backend::Btleplug => Ok(Arc::new(crate::ble_btleplug::BtleplugTransport::new(cfg)?)),
        Backend::Esphome => Ok(Arc::new(crate::ble_esphome::EsphomeTransport::new(cfg)?)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Test double: records writes and lets tests emit notifications.
    struct MockTransport {
        tx: broadcast::Sender<Vec<u8>>,
        writes: Arc<Mutex<Vec<Vec<u8>>>>,
    }
    impl MockTransport {
        fn new() -> Self {
            Self {
                tx: broadcast::channel(16).0,
                writes: Arc::new(Mutex::new(vec![])),
            }
        }
        fn emit(&self, data: Vec<u8>) {
            let _ = self.tx.send(data);
        }
    }
    #[async_trait]
    impl BleTransport for MockTransport {
        async fn connect(&self) -> Result<(), TransportError> {
            Ok(())
        }
        async fn write(&self, d: &[u8]) -> Result<(), TransportError> {
            self.writes.lock().unwrap().push(d.to_vec());
            Ok(())
        }
        async fn disconnect(&self) -> Result<(), TransportError> {
            Ok(())
        }
        async fn is_connected(&self) -> bool {
            true
        }
        fn subscribe(&self) -> NotifyRx {
            self.tx.subscribe()
        }
    }

    #[tokio::test]
    async fn notification_reaches_subscriber() {
        let t = MockTransport::new();
        let mut rx = t.subscribe();
        t.emit(vec![0xA7, 0xB3, 0x01]);
        assert_eq!(rx.recv().await.unwrap(), vec![0xA7, 0xB3, 0x01]);
    }

    #[tokio::test]
    async fn write_is_recorded() {
        let t = MockTransport::new();
        t.write(&[0x01, 0x02]).await.unwrap();
        assert_eq!(t.writes.lock().unwrap().as_slice(), &[vec![0x01, 0x02]]);
    }

    #[tokio::test]
    async fn build_esphome_does_not_touch_btleplug() {
        // The esphome backend must build without a local adapter present, and without connecting.
        let cfg = crate::config::Config::from_env_with(|k| match k {
            "BLE_BACKEND" => Some("esphome".into()),
            "ESPHOME_PROXY_HOST" => Some("127.0.0.1:1".into()),
            _ => None,
        })
        .unwrap();
        let t = super::build(&cfg).await;
        assert!(t.is_ok());
    }
}
