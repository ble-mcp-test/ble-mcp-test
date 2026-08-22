//! btleplug backend (default): local BLE radio via BlueZ/D-Bus.
//!
//! NOTE: temporary stub — the real find/connect/discover/subscribe/write/reconnect logic and
//! env-driven adapter selection land in Task 4. Present now so `transport::build` compiles.

use async_trait::async_trait;
use tokio::sync::broadcast;

use crate::config::Config;
use crate::transport::{BleTransport, NotifyRx, TransportError};

pub struct BtleplugTransport {
    tx: broadcast::Sender<Vec<u8>>,
}

impl BtleplugTransport {
    pub fn new(_cfg: &Config) -> Result<Self, TransportError> {
        Ok(Self {
            tx: broadcast::channel(256).0,
        })
    }
}

#[async_trait]
impl BleTransport for BtleplugTransport {
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
