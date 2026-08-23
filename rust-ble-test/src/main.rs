//! Rust BLE bridge: WebSocket (:8080) ↔ a BLE backend selected by config.
//!
//! The backend (btleplug local radio, or an ESPHome proxy over the network) is chosen at
//! startup via `BLE_BACKEND`. This file owns only the WS server, a global serialized command
//! channel (preserving FIFO write ordering across clients), and per-client notification fan-out;
//! all BLE specifics live behind the `BleTransport` trait.
//!
//! stdout contract: the Node observability layer (`src/rust-transport.ts`, :8081 /health + MCP log
//! buffer) parses this process's stdout. Every backend prints, on the matching event:
//!   - `✅ Connected on attempt N`   (connected=true)
//!   - `📤 BLE write successful: {:02X?}`
//!   - `📥 BLE notification: {:02X?}`

use futures::sink::SinkExt;
use futures::stream::StreamExt;
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::{accept_async, tungstenite::protocol::Message};

mod ble_btleplug;
mod ble_esphome;
mod config;
mod esphome_proto;
mod transport;

use transport::NotifyRx;

/// Handle one WebSocket client: forward its `{type:"data"}` commands into the global command
/// channel, and stream BLE notifications back out as `{type:"data"}` messages.
async fn handle_websocket_connection(
    stream: TcpStream,
    cmd_tx: mpsc::UnboundedSender<Vec<u8>>,
    mut notification_rx: NotifyRx,
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

    let connected_msg = json!({ "type": "connected", "device": "CS108Reader2603A7" });
    if let Err(e) = ws_sender.send(Message::Text(connected_msg.to_string())).await {
        println!("❌ Failed to send connected message: {}", e);
        return;
    }

    loop {
        tokio::select! {
            msg = ws_receiver.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(json_msg) = serde_json::from_str::<Value>(&text) {
                            if json_msg["type"] == "data" && json_msg["data"].is_array() {
                                let data: Result<Vec<u8>, _> = json_msg["data"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .map(|v| v.as_u64().ok_or("Invalid number").map(|n| n as u8))
                                    .collect();
                                if let Ok(bytes) = data {
                                    println!("RX: {:02X?}", bytes);
                                    if cmd_tx.send(bytes).is_err() {
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
                    _ => {}
                }
            }

            notification = notification_rx.recv() => {
                match notification {
                    Ok(data) => {
                        let notification_msg = json!({ "type": "data", "data": data });
                        if let Err(e) = ws_sender.send(Message::Text(notification_msg.to_string())).await {
                            println!("❌ Failed to send notification: {}", e);
                            break;
                        }
                        println!("TX: {:02X?}", data);
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        // A briefly-slow client; skip the missed items but keep serving.
                        println!("⚠️  WS client lagged, skipped {} notifications", n);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    println!("📱 WebSocket connection handler exiting");
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = config::Config::from_env().map_err(|e| -> Box<dyn std::error::Error> {
        format!("config error: {e}").into()
    })?;
    println!("🦀 Rust BLE bridge starting (backend={:?})", cfg.backend);

    let transport = transport::build(&cfg).await?;
    transport.connect().await?;

    // Global serialized command channel: preserves FIFO write ordering across all WS clients.
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let write_transport = transport.clone();
    tokio::spawn(async move {
        while let Some(bytes) = cmd_rx.recv().await {
            if let Err(e) = write_transport.write(&bytes).await {
                println!("❌ BLE write failed: {}", e);
            }
        }
    });

    // WebSocket server.
    let ws_listener = TcpListener::bind(&cfg.ws_bind)
        .await
        .unwrap_or_else(|e| panic!("Failed to bind {}: {e}", cfg.ws_bind));
    println!("📡 WebSocket server listening on ws://{}", cfg.ws_bind);

    let accept_transport = transport.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = ws_listener.accept().await {
            let cmd_tx = cmd_tx.clone();
            let notification_rx = accept_transport.subscribe();
            tokio::spawn(handle_websocket_connection(stream, cmd_tx, notification_rx));
        }
    });

    println!("💤 Rust BLE bridge ready");

    // Graceful shutdown on Ctrl+C / SIGTERM (PM2).
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("Failed to setup SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => println!("🔄 Received Ctrl+C signal, cleaning up..."),
        _ = sigterm.recv() => println!("🔄 Received SIGTERM signal, cleaning up..."),
    }

    let _ = transport.disconnect().await;
    println!("👋 Rust BLE bridge shutdown complete");
    Ok(())
}
