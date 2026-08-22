use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, WriteType, Characteristic};
use btleplug::platform::{Manager, Peripheral};
use futures::stream::StreamExt;
use futures::sink::SinkExt;
use rand::Rng;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use std::sync::Arc;
use tokio::time;
use tokio::sync::{Mutex, mpsc, broadcast};
use uuid::Uuid;
use tokio_tungstenite::{accept_async, tungstenite::protocol::Message};
use tokio::net::{TcpListener, TcpStream};

mod config;
mod transport;
mod ble_btleplug;
mod ble_esphome;
mod esphome_proto;

// Your device UUIDs
const SERVICE_UUID: Uuid = Uuid::from_u128(0x00009800_0000_1000_8000_00805f9b34fb);
const WRITE_CHAR_UUID: Uuid = Uuid::from_u128(0x00009900_0000_1000_8000_00805f9b34fb);
const NOTIFY_CHAR_UUID: Uuid = Uuid::from_u128(0x00009901_0000_1000_8000_00805f9b34fb);

/// Command structure for serializing BLE operations
#[derive(Debug)]
struct BleCommand {
    data: Vec<u8>,
}

/// Notification for WebSocket clients
#[derive(Debug, Clone)]
struct BleNotification {
    data: Vec<u8>,
}

/// Connection health monitoring and recovery
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
        // Open circuit breaker after 5 consecutive failures
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
            Duration::from_secs(30) // 30 second cooldown when circuit is open - give hardware time to reset
        } else {
            // Exponential backoff: 2s, 4s, 8s, 16s, max 30s
            let base_delay = std::cmp::min(2 << self.consecutive_failures, 30);
            Duration::from_secs(base_delay)
        }
    }
}


/// Connect to peripheral with exponential backoff retry
async fn connect_with_retry(peripheral: &Peripheral, max_attempts: u32) -> Result<(), Box<dyn std::error::Error>> {
    for attempt in 0..max_attempts {
        match peripheral.connect().await {
            Ok(_) => {
                println!("✅ Connected on attempt {}", attempt + 1);
                return Ok(());
            }
            Err(e) if attempt < max_attempts - 1 => {
                // Exponential backoff: 2^attempt * base_delay (1s)
                let base_delay_ms = (1 << attempt) * 1000; // 1s, 2s, 4s, 8s...
                let jitter_ms = rand::thread_rng().gen_range(0..500); // 0-500ms jitter
                let total_delay_ms = base_delay_ms + jitter_ms;

                println!("⚠️  Connection attempt {} failed: {}", attempt + 1, e);
                println!("   Retrying in {}ms...", total_delay_ms);

                time::sleep(Duration::from_millis(total_delay_ms)).await;
            }
            Err(e) => {
                println!("❌ All {} connection attempts failed. Last error: {}", max_attempts, e);
                return Err(e.into());
            }
        }
    }
    unreachable!()
}

/// Full reconnection cycle - disconnect, wait, reconnect, rediscover services
async fn full_reconnect_cycle(
    peripheral: &Peripheral,
    health: &Arc<Mutex<ConnectionHealth>>,
) -> Result<(Characteristic, Characteristic), String> {
    let mut health_guard = health.lock().await;
    health_guard.total_reconnects += 1;
    let cooldown = health_guard.get_cooldown_duration();
    drop(health_guard);

    println!("🔄 Full reconnect cycle starting (cooldown: {:?})", cooldown);

    // Disconnect first
    let _ = peripheral.disconnect().await;

    // Give hardware extra time to fully disconnect before cooldown
    time::sleep(Duration::from_secs(2)).await;
    time::sleep(cooldown).await;

    // Reconnect with retry
    connect_with_retry(peripheral, 3).await.map_err(|e| e.to_string())?;

    // Rediscover services
    println!("🔍 Rediscovering services after reconnect...");
    peripheral.discover_services().await.map_err(|e| e.to_string())?;
    let services = peripheral.services();

    let target_service = services.iter().find(|s| s.uuid == SERVICE_UUID)
        .ok_or("Service not found after reconnect")?;

    let write_char = target_service.characteristics.iter()
        .find(|c| c.uuid == WRITE_CHAR_UUID)
        .ok_or("Write characteristic not found after reconnect")?;

    let notify_char = target_service.characteristics.iter()
        .find(|c| c.uuid == NOTIFY_CHAR_UUID)
        .ok_or("Notify characteristic not found after reconnect")?;

    // Resubscribe to notifications
    peripheral.subscribe(&notify_char).await.map_err(|e| e.to_string())?;

    println!("✅ Full reconnect cycle completed");
    Ok((write_char.clone(), notify_char.clone()))
}

/// Safe write with connection health monitoring and auto-recovery
async fn safe_write_with_recovery(
    peripheral: &Peripheral,
    write_char: &mut Characteristic,
    notify_char: &mut Characteristic,
    data: &[u8],
    health: &Arc<Mutex<ConnectionHealth>>,
) -> Result<(), String> {
    // Check if we should attempt operation
    {
        let health_guard = health.lock().await;
        if !health_guard.should_attempt_reconnect() {
            return Err("Circuit breaker open - too many failures".to_string());
        }
    }

    // Check connection state before write
    match peripheral.is_connected().await {
        Ok(false) | Err(_) => {
            println!("🔄 Connection lost, attempting reconnect...");
            match full_reconnect_cycle(peripheral, health).await {
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
        Ok(true) => {} // Connected, proceed
    }

    // Attempt the write
    match peripheral.write(write_char, data, WriteType::WithoutResponse).await {
        Ok(_) => {
            health.lock().await.record_success();
            println!("📤 BLE write successful: {:02X?}", data);
            Ok(())
        }
        Err(e) => {
            let error_str = e.to_string();
            println!("❌ BLE write failed: {}", error_str);

            // Handle specific error types
            if error_str.contains("Not connected") ||
               error_str.contains("WriteValue") ||
               error_str.contains("doesn't exist") {
                println!("🔄 BlueZ corruption detected, forcing full reconnect...");

                match full_reconnect_cycle(peripheral, health).await {
                    Ok((new_write, new_notify)) => {
                        *write_char = new_write;
                        *notify_char = new_notify;

                        // Retry the write once after reconnect
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

/// Handle individual WebSocket connections
async fn handle_websocket_connection(
    stream: TcpStream,
    cmd_tx: mpsc::UnboundedSender<BleCommand>,
    mut notification_rx: broadcast::Receiver<BleNotification>,
) {
    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            println!("❌ WebSocket handshake failed: {}", e);
            return;
        }
    };

    println!("📱 New WebSocket client connected");

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // Send connected message
    let connected_msg = json!({
        "type": "connected",
        "device": "CS108Reader2603A7"
    });
    if let Err(e) = ws_sender.send(Message::Text(connected_msg.to_string())).await {
        println!("❌ Failed to send connected message: {}", e);
        return;
    }

    // Handle incoming WebSocket messages and outgoing notifications
    loop {
        tokio::select! {
            // Handle incoming WebSocket messages (commands from client)
            msg = ws_receiver.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(json_msg) = serde_json::from_str::<Value>(&text) {
                            if json_msg["type"] == "data" && json_msg["data"].is_array() {
                                // Convert JSON array to bytes
                                let data: Result<Vec<u8>, _> = json_msg["data"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .map(|v| v.as_u64().ok_or("Invalid number").map(|n| n as u8))
                                    .collect();

                                if let Ok(bytes) = data {
                                    println!("RX: {:02X?}", bytes);

                                    // Fire-and-forget command - responses come via notifications
                                    if cmd_tx.send(BleCommand {
                                        data: bytes,
                                    }).is_err() {
                                        println!("❌ BLE command channel closed");
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) => {
                        println!("📱 WebSocket client disconnected");
                        break;
                    }
                    Some(Err(e)) => {
                        println!("❌ WebSocket error: {}", e);
                        break;
                    }
                    None => break,
                    _ => {} // Ignore other message types
                }
            }

            // Handle BLE notifications (forward to WebSocket client)
            notification = notification_rx.recv() => {
                match notification {
                    Ok(notif) => {
                        let notification_msg = json!({
                            "type": "data",
                            "data": notif.data
                        });
                        if let Err(e) = ws_sender.send(Message::Text(notification_msg.to_string())).await {
                            println!("❌ Failed to send notification: {}", e);
                            break;
                        }
                        println!("TX: {:02X?}", notif.data);
                    }
                    Err(_) => {
                        // Channel closed
                        break;
                    }
                }
            }
        }
    }

    println!("📱 WebSocket connection handler exiting");
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("🦀 Starting Rust BLE test with btleplug");

    let manager = Manager::new().await?;
    let adapters = manager.adapters().await?;
    let central = adapters.into_iter().nth(0).unwrap();

    println!("✅ BLE adapter found");

    // Start scanning
    central.start_scan(ScanFilter::default()).await?;
    println!("Scanning for devices...");

    time::sleep(Duration::from_secs(5)).await;

    // Find devices
    let peripherals = central.peripherals().await?;
    println!("Found {} devices", peripherals.len());

    let mut target_peripheral: Option<Peripheral> = None;

    for peripheral in &peripherals {
        let properties = peripheral.properties().await?;
        if let Some(properties) = properties {
            if let Some(name) = properties.local_name {
                println!("  Device: {}", name);
            }

            // Check for our service UUID in advertised services
            if properties.services.contains(&SERVICE_UUID) {
                println!("✅ Found target device with service UUID!");
                target_peripheral = Some(peripheral.clone());
                break;
            }
        }
    }

    central.stop_scan().await?;

    let peripheral = match target_peripheral {
        Some(p) => p,
        None => {
            println!("⚠️  No device found with target service. Listing all devices:");
            for p in &peripherals {
                let props = p.properties().await?;
                if let Some(props) = props {
                    if let Some(name) = props.local_name {
                        println!("  - {}", name);
                    } else {
                        println!("  - <Unknown device>");
                    }
                }
            }
            return Ok(());
        }
    };

    // Ensure clean connection by disconnecting first if already connected
    if peripheral.is_connected().await? {
        println!("📱 Disconnecting existing connection...");
        let _ = peripheral.disconnect().await;
        time::sleep(Duration::from_millis(500)).await;
    }

    println!("Connecting to device with retry backoff...");
    connect_with_retry(&peripheral, 4).await?;

    println!("Discovering services (this may take a moment)...");
    // Add timeout wrapper for service discovery
    let discovery_result = tokio::select! {
        result = peripheral.discover_services() => result,
        _ = time::sleep(Duration::from_secs(10)) => {
            return Err("Service discovery timeout".into());
        }
    };

    discovery_result?;
    println!("✅ Services discovered!");
    let services = peripheral.services();

    let target_service = services.iter().find(|s| s.uuid == SERVICE_UUID);
    let service = match target_service {
        Some(s) => s,
        None => {
            println!("❌ Target service not found");
            return Ok(());
        }
    };

    let write_char = service.characteristics.iter().find(|c| c.uuid == WRITE_CHAR_UUID);
    let notify_char = service.characteristics.iter().find(|c| c.uuid == NOTIFY_CHAR_UUID);

    let write_char = write_char.ok_or("Write characteristic not found")?;
    let notify_char = notify_char.ok_or("Notify characteristic not found")?;

    println!("✅ Found characteristics");

    // Subscribe to notifications
    peripheral.subscribe(&notify_char).await?;
    println!("✅ Subscribed to notifications");

    // Initialize connection health monitoring
    let connection_health = Arc::new(Mutex::new(ConnectionHealth::new()));
    println!("🏥 Connection health monitoring initialized");

    // Create channels for serializing BLE operations
    let (ble_cmd_tx, mut ble_cmd_rx) = mpsc::unbounded_channel::<BleCommand>();
    let (notification_tx, _notification_rx) = broadcast::channel::<BleNotification>(100);

    // Start WebSocket server BEFORE the blocking BLE loop
    println!("🚀 Starting WebSocket server on port 8080");
    let ws_listener = TcpListener::bind("0.0.0.0:8080").await.expect("Failed to bind to port 8080");
    println!("📡 WebSocket server listening on ws://0.0.0.0:8080");

    let cmd_tx = ble_cmd_tx.clone();
    let notification_tx_ws = notification_tx.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = ws_listener.accept().await {
            let cmd_tx = cmd_tx.clone();
            let notification_rx = notification_tx_ws.subscribe();

            tokio::spawn(async move {
                handle_websocket_connection(stream, cmd_tx, notification_rx).await;
            });
        }
    });

    // Spawn single BLE operation handler task - ALL operations serialized
    let peripheral_ble = peripheral.clone();
    let mut write_char_ble = write_char.clone();
    let mut notify_char_ble = notify_char.clone();
    let health_ble = connection_health.clone();
    let notification_tx_ble = notification_tx.clone();
    tokio::spawn(async move {
        // Get single notification stream (avoid multiple streams race condition)
        let mut notification_stream = match peripheral_ble.notifications().await {
            Ok(stream) => stream,
            Err(e) => {
                println!("❌ Failed to get notification stream: {}", e);
                return;
            }
        };

        // FULLY SERIALIZED: Handle both commands and notifications in single task
        // This prevents any timing conflicts between write/notify operations
        loop {
            tokio::select! {
                // Handle write commands (from WebSocket clients)
                Some(cmd) = ble_cmd_rx.recv() => {
                    println!("📤 Processing BLE command: {:02X?}", cmd.data);

                    // Use same safe write logic but in fully serialized context
                    let result = safe_write_with_recovery(
                        &peripheral_ble,
                        &mut write_char_ble,
                        &mut notify_char_ble,
                        &cmd.data,
                        &health_ble
                    ).await;

                    // Fire-and-forget - just log errors
                    // The actual device response will come through notifications
                    if let Err(e) = result {
                        println!("❌ BLE write failed: {}", e);
                    }
                }

                // Handle notifications (from device)
                Some(data) = notification_stream.next() => {
                    println!("📥 BLE notification: {:02X?}", data.value);
                    let _ = notification_tx_ble.send(BleNotification {
                        data: data.value,
                    });
                }

                // Break if both channels are closed
                else => {
                    println!("🔌 BLE operation handler shutting down");
                    break;
                }
            }
        }
    });

    // Notification logging is now handled inline in the WebSocket handler
    // This ensures notifications are logged to stdout for MCP/parent process
    // monitoring at the same time they're sent to WebSocket clients

    // Keep the process running - WebSocket server and notification handlers will keep it alive
    println!("💤 Rust BLE bridge ready with WebSocket server on port 8080");

    // Set up signal handlers for graceful shutdown
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("Failed to setup SIGTERM handler");

    // Wait for shutdown signal (Ctrl+C or SIGTERM/SIGKILL from PM2)
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            println!("🔄 Received Ctrl+C signal, cleaning up...");
        }
        _ = sigterm.recv() => {
            println!("🔄 Received SIGTERM signal, cleaning up...");
        }
    }

    // IMPORTANT: Clean disconnect from BLE device to prevent hardware getting stuck
    if peripheral.is_connected().await? {
        println!("📱 Disconnecting from BLE device...");
        match peripheral.disconnect().await {
            Ok(_) => println!("✅ Cleanly disconnected from device"),
            Err(e) => println!("⚠️  Error disconnecting: {}", e),
        }

        // Give the Bluetooth stack time to clean up
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    println!("👋 Rust BLE bridge shutdown complete");
    Ok(())
}
