//! btleplug backend (default): local BLE radio via BlueZ/D-Bus.
//!
//! This preserves the original single-serialized-task concurrency model from `main.rs`: one task
//! owns the peripheral, its notification stream, and the write-command channel, handling both in a
//! `select!` loop so a write and a notification never overlap (the design the project relies on for
//! session stability). `write()` feeds that task via an mpsc; notifications fan out via a broadcast.
//!
//! Adapter selection is env-driven (`BLE_ADAPTER`) instead of `adapters.nth(0)`, closing the
//! STATE-OF-PLAY §11 "reboot roulette" risk where hci ordering changes across reboots.

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use btleplug::api::{Central, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::stream::StreamExt;
use rand::Rng;
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio::time;
use uuid::Uuid;

use crate::config::Config;
use crate::transport::{BleTransport, NotifyRx, TransportError};

/// Connection health monitoring and recovery.
#[derive(Debug)]
struct ConnectionHealth {
    consecutive_failures: u32,
    last_success: Option<Instant>,
    circuit_open: bool,
    total_reconnects: u32,
}

impl ConnectionHealth {
    fn new() -> Self {
        Self {
            consecutive_failures: 0,
            last_success: None,
            circuit_open: false,
            total_reconnects: 0,
        }
    }

    fn record_success(&mut self) {
        self.consecutive_failures = 0;
        self.last_success = Some(Instant::now());
        self.circuit_open = false;
    }

    fn record_failure(&mut self) -> bool {
        self.consecutive_failures += 1;
        if self.consecutive_failures >= 5 {
            self.circuit_open = true;
            true
        } else {
            false
        }
    }

    fn should_attempt_reconnect(&self) -> bool {
        !self.circuit_open || self.consecutive_failures < 10
    }

    fn get_cooldown_duration(&self) -> Duration {
        if self.circuit_open {
            Duration::from_secs(30)
        } else {
            let base_delay = std::cmp::min(2 << self.consecutive_failures, 30);
            Duration::from_secs(base_delay)
        }
    }
}

/// The three UUIDs identifying the target service/characteristics.
#[derive(Clone, Copy)]
struct Uuids {
    service: Uuid,
    write: Uuid,
    notify: Uuid,
}

/// Choose an adapter index from the adapters' info strings.
///
/// `None` selector => first adapter. Otherwise the first adapter whose info string contains the
/// selector (case-insensitive) — matches an hci name, a MAC substring, or any info fragment.
pub(crate) fn select_adapter(infos: &[String], selector: Option<&str>) -> Option<usize> {
    match selector {
        None => (!infos.is_empty()).then_some(0),
        Some(sel) => {
            let needle = sel.to_lowercase();
            infos.iter().position(|i| i.to_lowercase().contains(&needle))
        }
    }
}

/// Connect to peripheral with exponential backoff retry.
async fn connect_with_retry(
    peripheral: &Peripheral,
    max_attempts: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    for attempt in 0..max_attempts {
        match peripheral.connect().await {
            Ok(_) => {
                println!("✅ Connected on attempt {}", attempt + 1);
                return Ok(());
            }
            Err(e) if attempt < max_attempts - 1 => {
                let base_delay_ms = (1 << attempt) * 1000;
                let jitter_ms = rand::thread_rng().gen_range(0..500);
                let total_delay_ms = base_delay_ms + jitter_ms;
                println!("⚠️  Connection attempt {} failed: {}", attempt + 1, e);
                println!("   Retrying in {}ms...", total_delay_ms);
                time::sleep(Duration::from_millis(total_delay_ms)).await;
            }
            Err(e) => {
                println!(
                    "❌ All {} connection attempts failed. Last error: {}",
                    max_attempts, e
                );
                return Err(e.into());
            }
        }
    }
    unreachable!()
}

/// Full reconnection cycle - disconnect, wait, reconnect, rediscover services.
async fn full_reconnect_cycle(
    peripheral: &Peripheral,
    health: &Arc<Mutex<ConnectionHealth>>,
    uuids: Uuids,
) -> Result<(Characteristic, Characteristic), String> {
    let mut health_guard = health.lock().await;
    health_guard.total_reconnects += 1;
    let cooldown = health_guard.get_cooldown_duration();
    drop(health_guard);

    println!("🔄 Full reconnect cycle starting (cooldown: {:?})", cooldown);

    let _ = peripheral.disconnect().await;

    time::sleep(Duration::from_secs(2)).await;
    time::sleep(cooldown).await;

    connect_with_retry(peripheral, 3).await.map_err(|e| e.to_string())?;

    println!("🔍 Rediscovering services after reconnect...");
    peripheral.discover_services().await.map_err(|e| e.to_string())?;
    let services = peripheral.services();

    let target_service = services
        .iter()
        .find(|s| s.uuid == uuids.service)
        .ok_or("Service not found after reconnect")?;

    let write_char = target_service
        .characteristics
        .iter()
        .find(|c| c.uuid == uuids.write)
        .ok_or("Write characteristic not found after reconnect")?;

    let notify_char = target_service
        .characteristics
        .iter()
        .find(|c| c.uuid == uuids.notify)
        .ok_or("Notify characteristic not found after reconnect")?;

    peripheral.subscribe(notify_char).await.map_err(|e| e.to_string())?;

    println!("✅ Full reconnect cycle completed");
    Ok((write_char.clone(), notify_char.clone()))
}

/// Safe write with connection health monitoring and auto-recovery.
async fn safe_write_with_recovery(
    peripheral: &Peripheral,
    write_char: &mut Characteristic,
    notify_char: &mut Characteristic,
    data: &[u8],
    health: &Arc<Mutex<ConnectionHealth>>,
    uuids: Uuids,
) -> Result<(), String> {
    {
        let health_guard = health.lock().await;
        if !health_guard.should_attempt_reconnect() {
            return Err("Circuit breaker open - too many failures".to_string());
        }
    }

    match peripheral.is_connected().await {
        Ok(false) | Err(_) => {
            println!("🔄 Connection lost, attempting reconnect...");
            match full_reconnect_cycle(peripheral, health, uuids).await {
                Ok((new_write, new_notify)) => {
                    *write_char = new_write;
                    *notify_char = new_notify;
                }
                Err(e) => {
                    health.lock().await.record_failure();
                    return Err(format!("Reconnect failed: {}", e));
                }
            }
        }
        Ok(true) => {}
    }

    match peripheral.write(write_char, data, WriteType::WithoutResponse).await {
        Ok(_) => {
            health.lock().await.record_success();
            println!("📤 BLE write successful: {:02X?}", data);
            Ok(())
        }
        Err(e) => {
            let error_str = e.to_string();
            println!("❌ BLE write failed: {}", error_str);

            if error_str.contains("Not connected")
                || error_str.contains("WriteValue")
                || error_str.contains("doesn't exist")
            {
                println!("🔄 BlueZ corruption detected, forcing full reconnect...");
                match full_reconnect_cycle(peripheral, health, uuids).await {
                    Ok((new_write, new_notify)) => {
                        *write_char = new_write;
                        *notify_char = new_notify;
                        match peripheral.write(write_char, data, WriteType::WithoutResponse).await {
                            Ok(_) => {
                                health.lock().await.record_success();
                                println!("📤 BLE write successful after recovery: {:02X?}", data);
                                Ok(())
                            }
                            Err(retry_err) => {
                                health.lock().await.record_failure();
                                Err(format!("Write failed even after recovery: {}", retry_err))
                            }
                        }
                    }
                    Err(reconnect_err) => {
                        health.lock().await.record_failure();
                        Err(format!("Recovery failed: {}", reconnect_err))
                    }
                }
            } else {
                health.lock().await.record_failure();
                Err(e.to_string())
            }
        }
    }
}

/// Pick the adapter per the configured selector, logging the choice.
async fn choose_adapter(
    adapters: Vec<Adapter>,
    selector: Option<&str>,
) -> Result<Adapter, TransportError> {
    let mut infos = Vec::with_capacity(adapters.len());
    for a in &adapters {
        infos.push(a.adapter_info().await.unwrap_or_default());
    }
    match select_adapter(&infos, selector) {
        Some(idx) => {
            println!("✅ Using BLE adapter [{}]: {}", idx, infos[idx]);
            if selector.is_none() && adapters.len() > 1 {
                println!(
                    "⚠️  {} adapters present; defaulted to the first. Set BLE_ADAPTER to pin one.",
                    adapters.len()
                );
            }
            Ok(adapters.into_iter().nth(idx).unwrap())
        }
        None => Err(TransportError::Connect(format!(
            "no BLE adapter matched selector {:?}; available: {:?}",
            selector, infos
        ))),
    }
}

pub struct BtleplugTransport {
    uuids: Uuids,
    adapter_selector: Option<String>,
    tx: broadcast::Sender<Vec<u8>>,
    cmd_tx: mpsc::UnboundedSender<Vec<u8>>,
    cmd_rx: Mutex<Option<mpsc::UnboundedReceiver<Vec<u8>>>>,
}

impl BtleplugTransport {
    pub fn new(cfg: &Config) -> Result<Self, TransportError> {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        Ok(Self {
            uuids: Uuids {
                service: cfg.service_uuid,
                write: cfg.write_uuid,
                notify: cfg.notify_uuid,
            },
            adapter_selector: cfg.adapter_selector.clone(),
            tx: broadcast::channel(256).0,
            cmd_tx,
            cmd_rx: Mutex::new(Some(cmd_rx)),
        })
    }
}

#[async_trait]
impl BleTransport for BtleplugTransport {
    async fn connect(&self) -> Result<(), TransportError> {
        let uuids = self.uuids;
        println!("🦀 btleplug backend: initializing");

        let manager = Manager::new()
            .await
            .map_err(|e| TransportError::Connect(format!("manager: {e}")))?;
        let adapters = manager
            .adapters()
            .await
            .map_err(|e| TransportError::Connect(format!("adapters: {e}")))?;
        if adapters.is_empty() {
            return Err(TransportError::Connect("no BLE adapters found".into()));
        }
        let central = choose_adapter(adapters, self.adapter_selector.as_deref()).await?;

        central
            .start_scan(ScanFilter::default())
            .await
            .map_err(|e| TransportError::Connect(format!("start_scan: {e}")))?;
        println!("Scanning for devices...");
        time::sleep(Duration::from_secs(5)).await;

        let peripherals = central
            .peripherals()
            .await
            .map_err(|e| TransportError::Connect(format!("peripherals: {e}")))?;
        println!("Found {} devices", peripherals.len());

        let mut target: Option<Peripheral> = None;
        for peripheral in &peripherals {
            if let Ok(Some(props)) = peripheral.properties().await {
                if props.services.contains(&uuids.service) {
                    println!("✅ Found target device with service UUID!");
                    target = Some(peripheral.clone());
                    break;
                }
            }
        }
        let _ = central.stop_scan().await;

        let peripheral = target.ok_or_else(|| {
            TransportError::Connect("no device found advertising the target service".into())
        })?;

        if peripheral.is_connected().await.unwrap_or(false) {
            println!("📱 Disconnecting existing connection...");
            let _ = peripheral.disconnect().await;
            time::sleep(Duration::from_millis(500)).await;
        }

        println!("Connecting to device with retry backoff...");
        connect_with_retry(&peripheral, 4)
            .await
            .map_err(|e| TransportError::Connect(e.to_string()))?;

        println!("Discovering services (this may take a moment)...");
        let discovery = tokio::select! {
            r = peripheral.discover_services() => r,
            _ = time::sleep(Duration::from_secs(10)) => {
                return Err(TransportError::Connect("service discovery timeout".into()));
            }
        };
        discovery.map_err(|e| TransportError::Connect(format!("discover: {e}")))?;
        println!("✅ Services discovered!");

        let services = peripheral.services();
        let service = services
            .iter()
            .find(|s| s.uuid == uuids.service)
            .ok_or_else(|| TransportError::Connect("target service not found".into()))?;
        let write_char = service
            .characteristics
            .iter()
            .find(|c| c.uuid == uuids.write)
            .ok_or_else(|| TransportError::Connect("write characteristic not found".into()))?
            .clone();
        let notify_char = service
            .characteristics
            .iter()
            .find(|c| c.uuid == uuids.notify)
            .ok_or_else(|| TransportError::Connect("notify characteristic not found".into()))?
            .clone();
        println!("✅ Found characteristics");

        peripheral
            .subscribe(&notify_char)
            .await
            .map_err(|e| TransportError::Connect(format!("subscribe: {e}")))?;
        println!("✅ Subscribed to notifications");

        let health = Arc::new(Mutex::new(ConnectionHealth::new()));
        let notif_tx = self.tx.clone();
        let mut cmd_rx = self
            .cmd_rx
            .lock()
            .await
            .take()
            .ok_or_else(|| TransportError::Other("connect() called twice".into()))?;

        // Single serialized BLE task: writes and notifications never overlap.
        tokio::spawn(async move {
            let mut notification_stream = match peripheral.notifications().await {
                Ok(s) => s,
                Err(e) => {
                    println!("❌ Failed to get notification stream: {}", e);
                    return;
                }
            };
            let mut write_char = write_char;
            let mut notify_char = notify_char;

            loop {
                tokio::select! {
                    Some(cmd) = cmd_rx.recv() => {
                        println!("📤 Processing BLE command: {:02X?}", cmd);
                        if let Err(e) = safe_write_with_recovery(
                            &peripheral, &mut write_char, &mut notify_char, &cmd, &health, uuids,
                        ).await {
                            println!("❌ BLE write failed: {}", e);
                        }
                    }
                    Some(data) = notification_stream.next() => {
                        println!("📥 BLE notification: {:02X?}", data.value);
                        let _ = notif_tx.send(data.value);
                    }
                    else => {
                        println!("🔌 BLE operation handler shutting down");
                        break;
                    }
                }
            }
        });

        Ok(())
    }

    async fn write(&self, data: &[u8]) -> Result<(), TransportError> {
        // Fire-and-forget into the serialized task; device response arrives via notifications.
        self.cmd_tx
            .send(data.to_vec())
            .map_err(|_| TransportError::Write("BLE command channel closed".into()))
    }

    async fn disconnect(&self) -> Result<(), TransportError> {
        // Dropping the command sender ends the serialized task, which drops the peripheral.
        Ok(())
    }

    fn subscribe(&self) -> NotifyRx {
        self.tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::select_adapter;

    #[test]
    fn no_selector_picks_first() {
        let a = vec![
            "hci0 BC:FC:E7:2D:76:12".to_string(),
            "hci1 00:11:22:33:44:55".to_string(),
        ];
        assert_eq!(select_adapter(&a, None), Some(0));
    }
    #[test]
    fn selector_matches_mac_substring() {
        let a = vec![
            "hci0 BC:FC:E7:2D:76:12".to_string(),
            "hci1 00:11:22:33:44:55".to_string(),
        ];
        assert_eq!(select_adapter(&a, Some("00:11:22:33:44:55")), Some(1));
    }
    #[test]
    fn selector_matches_name_substring_case_insensitive() {
        let a = vec![
            "hci0 BC:FC:E7:2D:76:12".to_string(),
            "hci1 00:11:22:33:44:55".to_string(),
        ];
        assert_eq!(select_adapter(&a, Some("HCI1")), Some(1));
    }
    #[test]
    fn selector_no_match_returns_none() {
        let a = vec!["hci0 BC:FC:E7:2D:76:12".to_string()];
        assert_eq!(select_adapter(&a, Some("hci9")), None);
    }
    #[test]
    fn empty_adapters_no_selector_is_none() {
        assert_eq!(select_adapter(&[], None), None);
    }
}
