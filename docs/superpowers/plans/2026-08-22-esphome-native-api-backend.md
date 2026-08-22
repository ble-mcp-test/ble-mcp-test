# ESPHome native-API BLE backend (BleTransport trait) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, network-only BLE backend to the Rust bridge (`rust-ble-test`) that talks to an ESPHome Bluetooth Proxy over the native API (TCP/6053, protobuf), selectable at runtime alongside the existing btleplug backend, behind a common `BleTransport` trait.

**Architecture:** Extract the BLE operations currently hardcoded in `main.rs` (btleplug: find → connect → discover → subscribe → write-without-response → notify) behind an object-safe `BleTransport` trait. `main.rs` keeps ownership of the WebSocket server (:8080), the serialized command channel, and notification fan-out; it just drives a `Box<dyn BleTransport>` chosen by config. Two impls: `BtleplugTransport` (default, existing behavior + env-driven adapter selection) and `EsphomeTransport` (new). The ESPHome crate `esphome-native-api` 3.0.0 is **responder-only** (it emulates a device, it cannot act as a client), so we reuse only its public `proto` structs + `parser` codec functions and hand-write the ~200-line plaintext client (TCP framing + Hello/Auth handshake + BT-proxy message flow + keepalive).

**Tech Stack:** Rust (edition 2021, rustc 1.89), tokio (full), `async-trait`, `prost` 0.13, `esphome-native-api` 3.0.0 (default features `std` + `version_2026_6_2`), `thiserror`, existing `btleplug` 0.11 / `tokio-tungstenite` 0.20 / `serde_json` / `uuid` / `futures` / `rand`.

**Spec:** Linear TRA-1149 — "Add ESPHome native-API BLE backend to the Rust bridge (BleTransport trait)". Reference material: `scripts/esphome-probe/probe.py` (Python twin proving the proxy flow), `scripts/esphome-probe/waveshare-esp32-s3-eth.yaml` (bench proxy config), `STATE-OF-PLAY.md`, `/tmp/BRIDGE-TEST.md` (live coordination with the platform session).

## Global Constraints

- **Package manager: pnpm only** for the Node side (`pnpm build`, `pnpm pm2:restart`). Never npm/npx/yarn. Rust uses `cargo` directly.
- **btleplug stays the DEFAULT backend.** `BLE_BACKEND` unset or `=btleplug` ⇒ existing behavior, byte-for-byte. `=esphome` selects the new path. This is additive; do not regress session stability (the reason the project moved off Noble — see memory `rust-bridge-session-stability`).
- **Preserve the Node↔Rust stdout contract.** `src/rust-transport.ts` parses the Rust child's stdout for `/health` + MCP log buffer. These exact substrings must keep being printed by BOTH backends on the same events:
  - connect success ⇒ a line containing `✅ Connected on attempt` (Node sets `connected=true`).
  - outbound write ⇒ a line containing `📤 BLE write successful:` followed by `{:02X?}` of the bytes (e.g. `[A7, B3, ...]`).
  - inbound notification ⇒ a line containing `📥 BLE notification:` followed by `{:02X?}` of the bytes.
  Regex on the Node side is `\[([A-F0-9, ]+)\]`, so the `{:02X?}` Debug format of a `&[u8]`/`Vec<u8>` is required (uppercase hex, comma-space separated, bracketed).
- **Notification boundaries are sacred.** Each BLE notification (native CS108 ≤20 bytes, MTU 23) must be forwarded to WS clients as its own message. Never coalesce/re-split across notifications — the platform reassembler frames on packet headers but tail-latency/reorder/loss breaks it (see `/tmp/BRIDGE-TEST.md` investigation). The ESPHome path delivers one `BluetoothGattNotifyDataResponse` per proxy notify; forward each verbatim.
- **CS108 settling delays live in the client app, not the bridge.** The bridge must not add reordering/coalescing/artificial batching. Keep the write path a straight pass-through (see memory `cs108-settling-delays`).
- **No PSK on the bench proxy.** `waveshare-esp32-s3-eth.yaml` `api:` has no `encryption:` ⇒ plaintext. Implement plaintext fully. `ESPHOME_NOISE_PSK` is accepted in config but Noise encryption is a documented follow-up (crate's encrypted framing is private); if set, fail fast with a clear "Noise PSK not yet supported" error rather than silently connecting plaintext.
- **Containerization is descoped** to a follow-up ticket (owner decision, 2026-08-22). Keep the *architectural guarantee* in scope: when `BLE_BACKEND=esphome`, the process must not initialize btleplug/BlueZ/D-Bus at all (verified by a code path that never constructs a btleplug `Manager` in the esphome branch).
- **CS108 identity (defaults):** MAC `6C:79:B8:26:03:A7`; service `0x9800`, write char `0x9900`, notify char `0x9901` (16-bit UUIDs in the `0000xxxx-0000-1000-8000-00805f9b34fb` base). Bench proxy: host `192.168.50.170`, native API port `6053`, no PSK.

---

## File Structure

Restructure `rust-ble-test/src/` from a single `main.rs` into focused modules (binary crate with `mod` declarations in `main.rs`):

- `rust-ble-test/Cargo.toml` — add deps (`async-trait`, `prost`, `esphome-native-api`, `thiserror`).
- `rust-ble-test/src/main.rs` — entry point: load `Config::from_env()`, build the transport via `transport::build(&cfg)`, run the WS server (:8080) + serialized command task + notification fan-out against `Arc<dyn BleTransport>`. Owns nothing BLE-specific anymore.
- `rust-ble-test/src/config.rs` — `Config` struct + `Config::from_env()`; backend selection, device MAC/UUIDs, btleplug adapter selection, esphome proxy host/port/PSK, WS bind. Pure, unit-tested.
- `rust-ble-test/src/transport.rs` — `BleTransport` trait (object-safe, `async_trait`), `TransportError`, `NotifyRx` alias, `async fn build(cfg) -> Result<Arc<dyn BleTransport>>` factory, and a `MockTransport` (test-only) used to unit-test main's plumbing.
- `rust-ble-test/src/ble_btleplug.rs` — `BtleplugTransport`: the existing find/connect/discover/subscribe/write/reconnect logic (moved from `main.rs`), plus env-driven adapter selection replacing `adapters.nth(0)`.
- `rust-ble-test/src/ble_esphome.rs` — `EsphomeTransport`: the ESPHome native-API client (connect handshake, device connect, get-services, write, notify subscribe, disconnect, keepalive, reconnect).
- `rust-ble-test/src/esphome_proto.rs` — the hand-written wire layer: plaintext frame codec (`0x00 <varint len> <varint msgtype> <payload>`), MAC packing, UUID matching helpers. Pure, heavily unit-tested (this is the riskiest new code).

Docs touched: `README.md` (env vars / backends section), `STATE-OF-PLAY.md` (record the backend + adapter-selection fix), `.env.local.example` (new env vars).

---

## Task 1: Cargo scaffolding + module skeleton (compiles, btleplug path unchanged)

Establishes the module layout and dependencies without changing behavior. Deliverable: `cargo build --release` succeeds; the binary still runs the exact same btleplug flow (main.rs body temporarily unchanged, just split into a `run()` we will refactor).

**Files:**
- Modify: `rust-ble-test/Cargo.toml`
- Modify: `rust-ble-test/src/main.rs` (add empty `mod` decls)
- Create: `rust-ble-test/src/config.rs`, `transport.rs`, `ble_btleplug.rs`, `ble_esphome.rs`, `esphome_proto.rs` (stubs)

**Interfaces:**
- Produces: the module files exist and are declared; no public API yet.

- [ ] **Step 1: Add dependencies to `Cargo.toml`**

Append under `[dependencies]`:
```toml
async-trait = "0.1"
thiserror = "1"
prost = "0.13"
esphome-native-api = "3.0.0"
```

- [ ] **Step 2: Verify the dependency tree resolves**

Run: `cd rust-ble-test && cargo fetch`
Expected: resolves `esphome-native-api v3.0.0`, `prost v0.13.x`, `async-trait`, `thiserror` with no version conflicts.

- [ ] **Step 3: Create stub module files**

Each new `.rs` file starts with just a doc comment, e.g. `esphome_proto.rs`:
```rust
//! ESPHome native-API wire layer: plaintext framing, MAC/UUID helpers.
```
Create `config.rs`, `transport.rs`, `ble_btleplug.rs`, `ble_esphome.rs`, `esphome_proto.rs` with a one-line doc comment each.

- [ ] **Step 4: Declare modules in `main.rs`**

Add at the top of `main.rs` (after the `use` block):
```rust
mod config;
mod transport;
mod ble_btleplug;
mod ble_esphome;
mod esphome_proto;
```

- [ ] **Step 5: Build to verify nothing broke**

Run: `cd rust-ble-test && cargo build --release`
Expected: PASS (warnings about unused modules are fine).

- [ ] **Step 6: Commit**

```bash
git add rust-ble-test/Cargo.toml rust-ble-test/Cargo.lock rust-ble-test/src/
git commit -m "chore(tra-1149): scaffold module layout + esphome-native-api dep"
```

---

## Task 2: Config module (env parsing) — TDD

Parses all runtime configuration from environment variables. Pure logic, fully unit-testable, no hardware.

**Files:**
- Modify: `rust-ble-test/src/config.rs`
- Test: inline `#[cfg(test)] mod tests` in `config.rs`

**Interfaces:**
- Produces:
  ```rust
  pub enum Backend { Btleplug, Esphome }
  pub struct Config {
      pub backend: Backend,
      pub device_mac: String,        // "6C:79:B8:26:03:A7"
      pub service_uuid: uuid::Uuid,
      pub write_uuid: uuid::Uuid,
      pub notify_uuid: uuid::Uuid,
      pub ws_bind: String,           // "0.0.0.0:8080"
      pub adapter_selector: Option<String>, // btleplug: BLE_ADAPTER (name/index/mac substring)
      pub esphome_host: String,      // host only
      pub esphome_port: u16,         // default 6053
      pub esphome_psk: Option<String>,
  }
  impl Config {
      pub fn from_env() -> Result<Config, String>;
      pub fn parse_16bit_uuid(short: u16) -> uuid::Uuid; // 0x9800 -> 00009800-0000-1000-8000-00805f9b34fb
  }
  ```
- Env vars: `BLE_BACKEND` (default `btleplug`), `BLE_DEVICE_MAC` (default `6C:79:B8:26:03:A7`), `BLE_SERVICE_UUID`/`BLE_WRITE_UUID`/`BLE_NOTIFY_UUID` (default 9800/9900/9901, accept either 4-hex short or full UUID), `BLE_MCP_WS_PORT` (default 8080), `BLE_MCP_WS_HOST` (default 0.0.0.0), `BLE_ADAPTER` (optional), `ESPHOME_PROXY_HOST` (host, or `host:port`), `ESPHOME_PROXY_PORT` (default 6053), `ESPHOME_NOISE_PSK` (optional).

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_btleplug() {
        let c = Config::from_env_with(|_| None).unwrap();
        assert!(matches!(c.backend, Backend::Btleplug));
        assert_eq!(c.device_mac, "6C:79:B8:26:03:A7");
        assert_eq!(c.ws_bind, "0.0.0.0:8080");
        assert_eq!(c.esphome_port, 6053);
    }

    #[test]
    fn selects_esphome_and_parses_host_port() {
        let env = |k: &str| match k {
            "BLE_BACKEND" => Some("esphome".to_string()),
            "ESPHOME_PROXY_HOST" => Some("192.168.50.170:6053".to_string()),
            _ => None,
        };
        let c = Config::from_env_with(env).unwrap();
        assert!(matches!(c.backend, Backend::Esphome));
        assert_eq!(c.esphome_host, "192.168.50.170");
        assert_eq!(c.esphome_port, 6053);
    }

    #[test]
    fn short_uuid_expands_to_base() {
        assert_eq!(
            Config::parse_16bit_uuid(0x9800),
            uuid::Uuid::from_u128(0x00009800_0000_1000_8000_00805f9b34fb)
        );
    }

    #[test]
    fn unknown_backend_is_error() {
        let env = |k: &str| (k == "BLE_BACKEND").then(|| "noble".to_string());
        assert!(Config::from_env_with(env).is_err());
    }

    #[test]
    fn esphome_backend_requires_host() {
        let env = |k: &str| (k == "BLE_BACKEND").then(|| "esphome".to_string());
        assert!(Config::from_env_with(env).is_err()); // no ESPHOME_PROXY_HOST
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd rust-ble-test && cargo test config`
Expected: FAIL (no `Config`, `from_env_with`, etc.).

- [ ] **Step 3: Implement `config.rs`**

Implement `Backend`, `Config`, `parse_16bit_uuid`, and a testable `from_env_with<F: Fn(&str)->Option<String>>(get: F)` with `from_env()` delegating to `from_env_with(|k| std::env::var(k).ok())`. UUID parsing: if the value is 4 hex chars, treat as 16-bit short and expand via `parse_16bit_uuid`; else parse as full `uuid::Uuid`. Host/port: if `ESPHOME_PROXY_HOST` contains `:`, split; else use `ESPHOME_PROXY_PORT` or 6053. `esphome` backend with empty host ⇒ `Err`. Unknown backend string ⇒ `Err`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd rust-ble-test && cargo test config`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add rust-ble-test/src/config.rs
git commit -m "feat(tra-1149): env-driven Config with backend selection (TDD)"
```

---

## Task 3: `BleTransport` trait + `TransportError` + `MockTransport` — TDD

Defines the abstraction both backends implement and the plumbing contract `main.rs` depends on. `MockTransport` lets us test main's command/notify wiring without hardware.

**Files:**
- Modify: `rust-ble-test/src/transport.rs`
- Test: inline `#[cfg(test)] mod tests` in `transport.rs`

**Interfaces:**
- Produces:
  ```rust
  use async_trait::async_trait;
  use tokio::sync::broadcast;

  pub type NotifyRx = broadcast::Receiver<Vec<u8>>;

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

  #[async_trait]
  pub trait BleTransport: Send + Sync {
      /// Find + connect + discover + subscribe-notify. Idempotent-ish: safe to call once at startup.
      async fn connect(&self) -> Result<(), TransportError>;
      /// Write-without-response, serialized by the caller.
      async fn write(&self, data: &[u8]) -> Result<(), TransportError>;
      async fn disconnect(&self) -> Result<(), TransportError>;
      async fn is_connected(&self) -> bool;
      /// A fresh receiver of raw notification payloads (one item per BLE notification).
      fn subscribe(&self) -> NotifyRx;
  }

  /// Chosen by config. Never constructs a btleplug Manager on the esphome branch.
  pub async fn build(cfg: &crate::config::Config) -> Result<std::sync::Arc<dyn BleTransport>, TransportError>;
  ```
- Consumes: `crate::config::{Config, Backend}`.

- [ ] **Step 1: Write failing test (MockTransport round-trips a notification + records writes)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    pub struct MockTransport {
        tx: broadcast::Sender<Vec<u8>>,
        pub writes: Arc<Mutex<Vec<Vec<u8>>>>,
    }
    impl MockTransport {
        fn new() -> Self { Self { tx: broadcast::channel(16).0, writes: Arc::new(Mutex::new(vec![])) } }
        fn emit(&self, data: Vec<u8>) { let _ = self.tx.send(data); }
    }
    #[async_trait]
    impl BleTransport for MockTransport {
        async fn connect(&self) -> Result<(), TransportError> { Ok(()) }
        async fn write(&self, d: &[u8]) -> Result<(), TransportError> { self.writes.lock().unwrap().push(d.to_vec()); Ok(()) }
        async fn disconnect(&self) -> Result<(), TransportError> { Ok(()) }
        async fn is_connected(&self) -> bool { true }
        fn subscribe(&self) -> NotifyRx { self.tx.subscribe() }
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
        // esphome backend must build without a local adapter present.
        let cfg = crate::config::Config::from_env_with(|k| match k {
            "BLE_BACKEND" => Some("esphome".into()),
            "ESPHOME_PROXY_HOST" => Some("127.0.0.1:1".into()), // unreachable is fine; build() must not connect
            _ => None,
        }).unwrap();
        // build() constructs the transport object but does NOT call connect().
        let t = super::build(&cfg).await;
        assert!(t.is_ok());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd rust-ble-test && cargo test transport`
Expected: FAIL (trait/types/`build` absent).

- [ ] **Step 3: Implement the trait, error, alias, and `build` factory**

`build()` matches `cfg.backend`: `Btleplug => Ok(Arc::new(BtleplugTransport::new(cfg)?))`, `Esphome => Ok(Arc::new(EsphomeTransport::new(cfg)?))`. `new()` only stores config/creates channels — it does NOT connect or open a socket or construct a btleplug `Manager` (that happens in `connect()`), which is what makes the `build_esphome_does_not_touch_btleplug` test pass and guarantees the no-BlueZ property. (Until Tasks 4/8 land, provide temporary `new()` stubs returning a minimal object so this compiles; they are filled in there.)

- [ ] **Step 4: Run to verify pass**

Run: `cd rust-ble-test && cargo test transport`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add rust-ble-test/src/transport.rs
git commit -m "feat(tra-1149): BleTransport trait + TransportError + MockTransport (TDD)"
```

---

## Task 4: Extract `BtleplugTransport` behind the trait + env adapter selection — TDD (unit) + build

Moves the existing btleplug logic out of `main.rs` into `ble_btleplug.rs`, implementing `BleTransport`. Adds env-driven adapter selection replacing `adapters.nth(0)` (acceptance criterion 2). Behavior parity with today is validated on hardware in Task 10; the unit test here covers adapter selection.

**Files:**
- Modify: `rust-ble-test/src/ble_btleplug.rs`, `rust-ble-test/src/main.rs` (remove moved code in Task 5)
- Test: inline adapter-selection test in `ble_btleplug.rs`

**Interfaces:**
- Consumes: `Config`, `BleTransport`, `TransportError`, `NotifyRx`.
- Produces:
  ```rust
  pub struct BtleplugTransport { /* Arc<Mutex<...>> state, broadcast::Sender<Vec<u8>>, cfg */ }
  impl BtleplugTransport { pub fn new(cfg: &Config) -> Result<Self, TransportError>; }
  // impl BleTransport for BtleplugTransport { ... }
  // pub(crate) fn select_adapter(adapters: &[String], selector: Option<&str>) -> Option<usize>;
  ```

- [ ] **Step 1: Write failing test for `select_adapter`**

```rust
#[cfg(test)]
mod tests {
    use super::select_adapter;
    // adapters modeled by their info strings (btleplug Adapter::adapter_info()).
    #[test]
    fn no_selector_picks_first() {
        let a = vec!["hci0 BC:FC:E7:2D:76:12".to_string(), "hci1 00:11:22:33:44:55".to_string()];
        assert_eq!(select_adapter(&a, None), Some(0));
    }
    #[test]
    fn selector_matches_mac_substring() {
        let a = vec!["hci0 BC:FC:E7:2D:76:12".to_string(), "hci1 00:11:22:33:44:55".to_string()];
        assert_eq!(select_adapter(&a, Some("00:11:22:33:44:55")), Some(1));
    }
    #[test]
    fn selector_matches_name_substring_case_insensitive() {
        let a = vec!["hci0 BC:FC:E7:2D:76:12".to_string(), "hci1 00:11:22:33:44:55".to_string()];
        assert_eq!(select_adapter(&a, Some("hci1")), Some(1));
    }
    #[test]
    fn selector_no_match_returns_none() {
        let a = vec!["hci0 BC:FC:E7:2D:76:12".to_string()];
        assert_eq!(select_adapter(&a, Some("hci9")), None);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd rust-ble-test && cargo test ble_btleplug`
Expected: FAIL.

- [ ] **Step 3: Implement `select_adapter` + `BtleplugTransport`**

`select_adapter`: if `selector` is `None`, `Some(0)` when non-empty. Else return the index of the first adapter whose info string contains the selector (case-insensitive). Move the following from `main.rs` into `BtleplugTransport`, adapting `Manager::new`/`adapters()` to call `select_adapter(&infos, cfg.adapter_selector.as_deref())` instead of `nth(0)` (log the chosen adapter + a warning on `None`): `connect_with_retry`, `full_reconnect_cycle`, `safe_write_with_recovery`, `ConnectionHealth`, the startup find/connect/discover/subscribe, and the notification pump. `connect()` performs startup + spawns the notification task pushing each `data.value` into the broadcast (and printing `📥 BLE notification: {:02X?}`). `write()` wraps `safe_write_with_recovery` (which already prints `📤 BLE write successful: {:02X?}`). Preserve the `✅ Connected on attempt` print in `connect_with_retry`. `subscribe()` returns `self.tx.subscribe()`.

- [ ] **Step 4: Run to verify pass + build**

Run: `cd rust-ble-test && cargo test ble_btleplug && cargo build --release`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust-ble-test/src/ble_btleplug.rs rust-ble-test/src/main.rs
git commit -m "feat(tra-1149): extract BtleplugTransport + env adapter selection (TDD)"
```

---

## Task 5: Wire `main.rs` to drive `Arc<dyn BleTransport>` — build + hardware smoke

`main.rs` becomes backend-agnostic: load config, build transport, connect, then run the WS server + serialized command task + per-client notification subscription. Deliverable validated by the btleplug hardware smoke (Task 10 item A) but must build + run here.

**Files:**
- Modify: `rust-ble-test/src/main.rs`

**Interfaces:**
- Consumes: `config::Config`, `transport::{build, BleTransport}`.

- [ ] **Step 1: Rewrite `main()`**

```rust
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = config::Config::from_env().map_err(|e| format!("config error: {e}"))?;
    println!("🦀 Rust BLE bridge starting (backend={:?})", cfg.backend);

    let transport = transport::build(&cfg).await?;
    transport.connect().await?;               // prints "✅ Connected on attempt N"

    // WS server on cfg.ws_bind; each client gets transport.subscribe() for notifications
    // and sends {type:"data",data:[..]} commands into a single mpsc consumed below.
    let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    // ... spawn WS accept loop (see Step 2) ...

    // Single serialized command task (preserves ordering + write recovery):
    let t = transport.clone();
    tokio::spawn(async move {
        while let Some(bytes) = cmd_rx.recv().await {
            if let Err(e) = t.write(&bytes).await { println!("❌ BLE write failed: {e}"); }
        }
    });

    // signal handling + graceful disconnect as before, then transport.disconnect().await
}
```

- [ ] **Step 2: Adapt the WS handler**

Keep `handle_websocket_connection` but replace its `notification_rx: broadcast::Receiver<BleNotification>` with `NotifyRx` (`broadcast::Receiver<Vec<u8>>`) obtained from `transport.subscribe()` in the accept loop, and its command path to `cmd_tx.send(bytes)`. The outbound notification JSON stays `{"type":"data","data":[..]}`; the `connected` handshake message stays. Preserve the `RX:`/`TX:` prints.

- [ ] **Step 3: Build**

Run: `cd rust-ble-test && cargo build --release`
Expected: PASS. Then `cargo clippy --release -- -D warnings` (fix lints).

- [ ] **Step 4: Local sanity (no hardware needed): esphome build path starts + fails to connect cleanly**

Run: `BLE_BACKEND=esphome ESPHOME_PROXY_HOST=127.0.0.1:1 ./target/release/rust-ble-test` (expect a clean "connect failed" error, NOT a btleplug/D-Bus error — proves the no-BlueZ branch).

- [ ] **Step 5: Commit**

```bash
git add rust-ble-test/src/main.rs
git commit -m "feat(tra-1149): drive Arc<dyn BleTransport> from main, backend-agnostic WS server"
```

---

## Task 6: ESPHome plaintext frame codec — TDD

The wire framing for the native API in plaintext mode: `0x00 <varint payload_len> <varint message_type> <payload bytes>`. Pure, no I/O, the riskiest new code — test exhaustively.

**Files:**
- Modify: `rust-ble-test/src/esphome_proto.rs`
- Test: inline tests in `esphome_proto.rs`

**Interfaces:**
- Produces:
  ```rust
  /// Encode one plaintext frame: 0x00, varint(len), varint(msg_type), payload.
  pub fn encode_frame(msg_type: u8, payload: &[u8]) -> Vec<u8>;
  /// Try to decode one frame from the front of `buf`.
  /// Returns Ok(Some((msg_type, payload, consumed))) if a whole frame is present,
  /// Ok(None) if more bytes are needed, Err on a malformed frame (bad preamble).
  pub fn decode_frame(buf: &[u8]) -> Result<Option<(u32, Vec<u8>, usize)>, FrameDecodeError>;
  pub fn write_varint(v: u64, out: &mut Vec<u8>);
  pub fn read_varint(buf: &[u8]) -> Option<(u64, usize)>; // (value, bytes_read)
  #[derive(thiserror::Error, Debug, PartialEq)] pub enum FrameDecodeError { #[error("bad preamble byte {0:#x}")] BadPreamble(u8) }
  ```

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_roundtrip() {
        for v in [0u64, 1, 127, 128, 300, 16384, 1_000_000] {
            let mut b = vec![]; write_varint(v, &mut b);
            assert_eq!(read_varint(&b), Some((v, b.len())));
        }
    }

    #[test]
    fn encode_hello_frame_shape() {
        // msg_type 1, empty payload -> [0x00, 0x00, 0x01]
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
        assert!(decode_frame(&frame[..2]).unwrap().is_none()); // header incomplete
        assert!(decode_frame(&frame[..frame.len()-1]).unwrap().is_none()); // body incomplete
    }

    #[test]
    fn decode_two_frames_in_stream() {
        let mut s = encode_frame(8, &[]);          // PingResponse
        s.extend(encode_frame(79, &[0xAA]));       // notify data
        let (t1, _, c1) = decode_frame(&s).unwrap().unwrap();
        assert_eq!(t1, 8);
        let (t2, p2, _) = decode_frame(&s[c1..]).unwrap().unwrap();
        assert_eq!((t2, p2), (79, vec![0xAA]));
    }

    #[test]
    fn bad_preamble_errors() {
        assert_eq!(decode_frame(&[0x01, 0x00, 0x01]), Err(FrameDecodeError::BadPreamble(0x01)));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd rust-ble-test && cargo test esphome_proto::tests::` (or `cargo test frame`)
Expected: FAIL.

- [ ] **Step 3: Implement the codec**

Standard protobuf base-128 varints. `decode_frame`: need ≥1 byte for preamble (must be `0x00`, else `BadPreamble`); then read len varint, then type varint; if either varint incomplete or `buf` shorter than header+len ⇒ `Ok(None)`; else return `(msg_type, payload.to_vec(), consumed)`.

- [ ] **Step 4: Run to verify pass**

Run: `cd rust-ble-test && cargo test esphome_proto`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add rust-ble-test/src/esphome_proto.rs
git commit -m "feat(tra-1149): ESPHome plaintext frame codec + varints (TDD)"
```

---

## Task 7: MAC packing + GATT UUID matching helpers — TDD

Helpers the ESPHome transport needs: pack a MAC string into the `u64` address the proxy uses, and find a characteristic's `handle` by our 16-bit UUID within a `BluetoothGattGetServicesResponse`.

**Files:**
- Modify: `rust-ble-test/src/esphome_proto.rs`
- Test: inline tests

**Interfaces:**
- Produces:
  ```rust
  pub fn mac_to_u64(mac: &str) -> Result<u64, String>;       // "6C:79:B8:26:03:A7" -> 0x6C79B82603A7
  /// Find the GATT handle for a 16-bit characteristic UUID across the proxy's service list.
  /// The proxy encodes a 128-bit UUID as two u64 (`uuid: Vec<u64>`) or a `short_uuid: u32`.
  pub fn find_char_handle(
      services: &[esphome_native_api::proto::BluetoothGattService],
      short_uuid: u16,
  ) -> Option<u32>;
  ```

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod uuid_tests {
    use super::*;
    use esphome_native_api::proto::{BluetoothGattService, BluetoothGattCharacteristic};

    #[test]
    fn mac_packs_big_endian_low48() {
        assert_eq!(mac_to_u64("6C:79:B8:26:03:A7").unwrap(), 0x6C79B82603A7);
    }
    #[test]
    fn mac_rejects_garbage() { assert!(mac_to_u64("nope").is_err()); }

    #[test]
    fn finds_handle_by_short_uuid() {
        let svc = BluetoothGattService {
            characteristics: vec![
                BluetoothGattCharacteristic { handle: 42, short_uuid: 0x9900, ..Default::default() },
                BluetoothGattCharacteristic { handle: 43, short_uuid: 0x9901, ..Default::default() },
            ],
            ..Default::default()
        };
        assert_eq!(find_char_handle(&[svc], 0x9900), Some(42));
    }

    #[test]
    fn finds_handle_by_128bit_pair() {
        // 16-bit 0x9901 in base UUID 0000xxxx-0000-1000-8000-00805f9b34fb.
        // Encoded as two u64: high = 0x0000990100001000, low = 0x800000805f9b34fb.
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
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd rust-ble-test && cargo test esphome_proto`
Expected: FAIL.

- [ ] **Step 3: Implement helpers**

`mac_to_u64`: split on `:`, require 6 hex bytes, fold big-endian into `u64`. `find_char_handle`: for each service→characteristic, match if `short_uuid as u16 == want` OR the `uuid: Vec<u64>` decodes to the 16-bit-in-base-UUID form for `want` (compare against the expected `[0x0000_wwww_0000_1000, 0x8000_0080_5f9b_34fb]`). Return the first `handle`. **Verify the exact 128-bit two-`u64` byte order against a live `GetServicesResponse` in Task 8** (the split/order is the one inferred point — the test encodes the assumption; adjust both if the live proxy differs, and note it in the commit).

- [ ] **Step 4: Run to verify pass**

Run: `cd rust-ble-test && cargo test esphome_proto`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust-ble-test/src/esphome_proto.rs
git commit -m "feat(tra-1149): MAC packing + GATT UUID→handle matching (TDD)"
```

---

## Task 8: `EsphomeTransport` — client handshake + BT-proxy flow + keepalive — build + hardware integration

The heart of the ticket. Implements `BleTransport` over the ESPHome native API using the codec + helpers + the crate's `proto`/`parser`. Uses `parser::{proto_to_vec, message_to_num, parse_proto_message}` for payloads and `esphome_proto::{encode_frame, decode_frame}` for framing.

**Files:**
- Modify: `rust-ble-test/src/ble_esphome.rs`

**Interfaces:**
- Consumes: `Config`, `BleTransport`, `TransportError`, `NotifyRx`, `esphome_proto::*`, `esphome_native_api::{proto, parser}`.
- Produces: `pub struct EsphomeTransport`; `impl EsphomeTransport { pub fn new(cfg: &Config) -> Result<Self, TransportError>; }` + `impl BleTransport`.

**Message flow (all confirmed against crate source + `probe.py`):**
1. `new()`: store host/port/mac/uuids/psk + create `broadcast::channel(256)`. If `psk.is_some()` return `Err(TransportError::Other("Noise PSK not yet supported; use a plaintext proxy"))`.
2. `connect()`: `TcpStream::connect((host, port))`. Send `HelloRequest { client_info: "ble-mcp-test-rust".into(), api_version_major: 1, api_version_minor: 10 }` (type 1); read frames until `HelloResponse` (2). Send `AuthenticationRequest { password: "".into() }` (3); read until `AuthenticationResponse` (4) and assert `!invalid_password`. Send `BluetoothDeviceRequest { address: mac_u64, request_type: BluetoothDeviceRequestType::ConnectV3WithoutCache as i32, ..Default::default() }` (68); read until `BluetoothDeviceConnectionResponse { connected: true, .. }` (69) for our address (bail on `error != 0`). Send `BluetoothGattGetServicesRequest { address }` (70); collect `BluetoothGattGetServicesResponse` (71) until `BluetoothGattGetServicesDoneResponse` (72); `find_char_handle` for write (0x9900) + notify (0x9901). Send `BluetoothGattNotifyRequest { address, handle: notify_handle, enable: true }` (78); await `BluetoothGattNotifyResponse` (84). Print `✅ Connected on attempt 1`. Store `write_handle`, split the socket, and spawn the **read loop** + **keepalive**.
3. Read loop: accumulate bytes, `decode_frame` in a loop; for each `ProtoMessage` via `parse_proto_message`: `BluetoothGattNotifyDataResponse{handle,data,..}` matching `notify_handle` ⇒ print `📥 BLE notification: {:02X?}` and `broadcast.send(data)`; `PingRequest` ⇒ reply `PingResponse` (8); `BluetoothDeviceConnectionResponse{connected:false,..}` or `DisconnectRequest` ⇒ mark disconnected + attempt reconnect; `BluetoothGattErrorResponse` ⇒ log. Ignore others.
4. Keepalive: every 20s send `PingRequest` (7).
5. `write()`: require connected; send `BluetoothGattWriteRequest { address, handle: write_handle, response: false, data: data.to_vec() }` (75); print `📤 BLE write successful: {:02X?}`. (write-without-response ⇒ no ack expected.)
6. `disconnect()`: send `BluetoothDeviceRequest { request_type: Disconnect as i32 }` (68) then `DisconnectRequest` (5); close socket.
7. `subscribe()`: `self.tx.subscribe()`.
8. Reconnect: on link loss (read loop end / connection false), re-run the `connect()` body with backoff (mirror btleplug's `ConnectionHealth` cadence: 2s→30s), so session persistence holds across proxy/link blips.

Send helper:
```rust
fn frame_for(msg: &parser::ProtoMessage) -> Vec<u8> {
    let ty = parser::message_to_num(msg).expect("known msg");
    let payload = parser::proto_to_vec(msg).expect("encodable");
    esphome_proto::encode_frame(ty, &payload)
}
```

- [ ] **Step 1: Write a compile-level unit test (frame_for round-trips through the codec)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use esphome_native_api::{proto::HelloRequest, parser::ProtoMessage};
    #[test]
    fn hello_frames_and_parses_back() {
        let msg = ProtoMessage::HelloRequest(HelloRequest {
            client_info: "x".into(), api_version_major: 1, api_version_minor: 10,
        });
        let frame = super::frame_for(&msg);
        let (ty, payload, _) = crate::esphome_proto::decode_frame(&frame).unwrap().unwrap();
        assert_eq!(ty, 1);
        let back = esphome_native_api::parser::parse_proto_message(ty as usize, &payload).unwrap();
        assert!(matches!(back, ProtoMessage::HelloRequest(_)));
    }
}
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `cd rust-ble-test && cargo test ble_esphome` (FAIL), implement per the flow above, then `cargo test ble_esphome && cargo build --release && cargo clippy --release -- -D warnings`.

- [ ] **Step 3: Commit the implementation**

```bash
git add rust-ble-test/src/ble_esphome.rs
git commit -m "feat(tra-1149): ESPHome native-API client transport (handshake, BT proxy flow, keepalive)"
```

- [ ] **Step 4: Hardware integration — one-shot proxy round-trip** (coordinated; see Task 10)

Free the reader (announce in `/tmp/BRIDGE-TEST.md`, `pnpm pm2:stop`, `bluetoothctl disconnect 6C:79:B8:26:03:A7`). Run `BLE_BACKEND=esphome ESPHOME_PROXY_HOST=192.168.50.170 ./target/release/rust-ble-test`, connect a WS client (a tiny node/wscat sending the battery command `A7 B3 02 D9 82 37 00 00 A0 00`), confirm a `📥 BLE notification:` reply. Fix any handle/UUID-order discrepancies found (Task 7 note). Record result in `/tmp/BRIDGE-TEST.md` + STATE-OF-PLAY.

---

## Task 9: Docs + config example

**Files:**
- Modify: `README.md` (add a "Backends" section: `BLE_BACKEND`, adapter selection, ESPHome env vars, Noise-as-follow-up), `.env.local.example` (new vars with comments), `STATE-OF-PLAY.md` (note §11 reboot-roulette fix + the new backend + the crate responder-only finding).

- [ ] **Step 1: Write the docs** — document every env var from Task 2, the stdout contract note, and that containerization + Noise/PSK are follow-ups (with the reasoning: crate is responder-only, encrypted framing private).
- [ ] **Step 2: Commit**

```bash
git add README.md .env.local.example STATE-OF-PLAY.md
git commit -m "docs(tra-1149): document backends, adapter selection, ESPHome env + scope notes"
```

---

## Task 10: Hardware validation (coordinated with the platform session)

Not a code task — the acceptance evidence. Drive it through `/tmp/BRIDGE-TEST.md`. Reader is shared 3 ways (this build, the platform e2e, TRA-1150); announce before grabbing it and never tear down a session-held keep-warm link externally.

- [ ] **A. btleplug regression (criterion: no regression).** Ask the platform session to run `pnpm test:hardware` against the rebuilt binary on the btleplug path (default). Expect the smoke round-trip to pass. Confirms the refactor preserved behavior.
- [ ] **B. ESPHome one-shot** (Task 8 Step 4) — proves connect→write→notify over the proxy.
- [ ] **C. Probe parity (criterion 4).** Run the four `probe.py` dimensions against `192.168.50.170` (recover ×10, poll, thrash, inventory) — these are our own instruments and do NOT hit the TRA-1150 app wedge. Compare to the TRA-1113 baselines (recover 10/10, poll ≥99.9%, thrash 100%, inventory streamGaps=0). NOTE: `probe.py` uses Python bleak-esphome, which validates the *proxy*, not our Rust client — additionally run an equivalent round-trip through our Rust esphome bridge (a WS client driving the same commands) to validate the Rust path end-to-end.
- [ ] **D. Platform e2e (criterion 3)** — ONLY after TRA-1150's fix has landed on platform main (coordinate via the file). Point the platform `dev:bridge` at the esphome-backed bridge and run `inventory.spec.ts` + `bridge-hop-count.spec.ts`. Read any red against the TRA-1150 wedge signature FIRST (`Failed to stop scanning: Command timeout`, fast ~8s 0-read fail = the app bug, never the backend). Pass condition: hop A ≈ hop B ≈ proxy TX with a sane tag count.
- [ ] **E. Record** all numbers in `/tmp/BRIDGE-TEST.md` + STATE-OF-PLAY, and summarize in the PR.

---

## Self-Review

**1. Spec coverage (acceptance criteria → task):**
- AC1 (trait + both backends + config select) → Tasks 2,3,4,5,8. ✓
- AC2 (adapter selection not `nth(0)`) → Task 4 (`select_adapter`). ✓
- AC3 (platform e2e over esphome) → Task 10-D (gated on TRA-1150). ✓ (validation deferred, coordinated)
- AC4 (four-dimension probe parity) → Task 10-C. ✓
- AC5 (container, no BlueZ/D-Bus) → **descoped by owner**; architectural guarantee (no btleplug init on esphome branch) → Tasks 3 (`build_esphome_does_not_touch_btleplug`) + 5 Step 4. Container artifact = follow-up ticket. Noted, not silently dropped. ✓
- AC6 (session persistence + settling + compact inventory over esphome) → Task 8 (keepalive + reconnect = keep-warm; pass-through write = settling; per-notify forward = compact 0x8005 intact) + Task 10-C/D. ✓
- Stretch (`/health` session_held vs free) → Node-side (:8081), explicitly out of this Rust scope; noted in Task 9 docs, not silently done. ✓

**2. Placeholder scan:** Code steps carry real code (config, codec, helpers, trait, handshake message list with exact type-ids/fields). Refactor tasks (4,5,8) reference exact existing symbols + the confirmed message flow. Task 7's 128-bit UUID byte-order is flagged as the one inferred point with a live-verify checkpoint in Task 8 — not a hidden TODO. No "TBD"/"handle edge cases"/"similar to". ✓

**3. Type consistency:** `BleTransport` methods (`connect`/`write`/`disconnect`/`is_connected`/`subscribe`) identical across trait def (Task 3), btleplug (Task 4), esphome (Task 8), and main (Task 5). `NotifyRx = broadcast::Receiver<Vec<u8>>` consistent. `Config` fields referenced in Tasks 4/5/8 match Task 2. `esphome_proto` signatures (`encode_frame`/`decode_frame`/`mac_to_u64`/`find_char_handle`) consistent between Tasks 6/7 and their use in Task 8. Type-ids (1,2,3,4,5,7,8,68,69,70,71,72,75,78,79,84) match `parser.rs`. ✓
