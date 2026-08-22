//! ESPHome native-API backend: talks to a Bluetooth Proxy over TCP (no local radio).
//!
//! NOTE: temporary stub — the real client handshake + BT-proxy flow land in Task 8. Present now
//! so `transport::build` compiles. `new()` already rejects a Noise PSK (documented follow-up).

use async_trait::async_trait;
use tokio::sync::broadcast;

use crate::config::Config;
use crate::transport::{BleTransport, NotifyRx, TransportError};

pub struct EsphomeTransport {
    tx: broadcast::Sender<Vec<u8>>,
}

impl EsphomeTransport {
    pub fn new(cfg: &Config) -> Result<Self, TransportError> {
        if cfg.esphome_psk.is_some() {
            return Err(TransportError::Other(
                "Noise PSK not yet supported; use a plaintext ESPHome proxy (ESPHOME_NOISE_PSK unset)"
                    .to_string(),
            ));
        }
        Ok(Self {
            tx: broadcast::channel(256).0,
        })
    }
}

#[async_trait]
impl BleTransport for EsphomeTransport {
    async fn connect(&self) -> Result<(), TransportError> {
        Ok(())
    }
    async fn write(&self, _data: &[u8]) -> Result<(), TransportError> {
        Ok(())
    }
    async fn disconnect(&self) -> Result<(), TransportError> {
        Ok(())
    }
    async fn is_connected(&self) -> bool {
        false
    }
    fn subscribe(&self) -> NotifyRx {
        self.tx.subscribe()
    }
}
