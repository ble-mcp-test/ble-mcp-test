## BUGS:
- Session reuse is still broken in client testing. See logs in examples. Local storage retrieves the session id, mock requests connection, server tries to start a new different session.
- Session Idle time out does not get applied and kill stale sessions. Grace period timeouts work. Idle timeouts do not

## Examples
### test report from client app
● Ha! I can see your frustration! The v0.5.3 logs clearly show the localStorage
  persistence IS working on the client side - both tests use the same session ID
  OXNC. But something is still broken on the bridge server side.

  The console logs show perfect session reuse:
  - Test 1: session":"127.0.0.1-chrome-OXNC" ✅
  - Test 2: session":"127.0.0.1-chrome-OXNC" ✅ (same!)

  But the second test still can't connect. This suggests the bridge server either:
  1. Isn't recognizing the reused session
  2. Has the session in a bad state
  3. Isn't properly handling reconnection to the same session

  The bridge logs just show continuous battery notifications (A7 B3 04 D9...) but no
  new connection attempts, which is suspicious.

  This feels like a bridge server bug where it's not properly implementing the
  session reconnection logic, even though the client is sending the right session ID.
   Your cousin ble-mcp-claude needs to check why the bridge isn't accepting
  reconnections to existing sessions!
### server log from client test
[Bridge] New WebSocket connection for session: 127.0.0.1-chrome-OXNC
[SessionManager] Creating new session: 127.0.0.1-chrome-OXNC
[Session:127.0.0.1-chrome-OXNC] Created with grace=60s, idle=180s
[Session:127.0.0.1-chrome-OXNC] Establishing new BLE connection
[Noble] State: unknown, waiting for power on...
[Noble] Starting BLE scan for 6c79b82603a7...
[Noble] Found device: 6c79b82603a7
[Noble] Connecting to 6c79b82603a7...
[Noble] Notification subscription attempt 1/3
[Noble] Notification subscription successful
[Noble] Connected successfully to 6c79b82603a7
[Session:127.0.0.1-chrome-OXNC] Connected to 6c79b82603a7
[SharedState] 📊 State updated: {"connected":false,"deviceName":null,"recovering":false,"connectedAt":null} → {"connected":true,"deviceName":"6c79b82603a7","recovering":false,"connectedAt":"2025-08-01T12:00:17.847Z"}
[Session:127.0.0.1-chrome-OXNC] Added WebSocket (1 active)
[WSHandler] TX: a7 b3 02 c2 82 37 00 00 80 01
[WSHandler] RX: a7 b3 03 c2 82 9e 18 99 80 01 00
[WSHandler] TX: a7 b3 02 c2 82 37 00 00 80 00
[WSHandler] RX: a7 b3 03 c2 82 9e 01 41 80 00 00
[WSHandler] TX: a7 b3 02 d9 82 37 00 00 a0 00
[WSHandler] RX: a7 b3 04 d9 82 9e b0 f1 a0 00 0f e5
[WSHandler] TX: a7 b3 02 d9 82 37 00 00 a0 02
[WSHandler] RX: a7 b3 03 d9 82 9e 5e 5f a0 02 00
[WSHandler] TX: a7 b3 02 d9 82 37 00 00 a0 01
[WSHandler] RX: a7 b3 03 d9 82 9e 74 37 a0 01 00
[WSHandler] RX: a7 b3 04 d9 82 9e b0 f1 a0 00 0f e5
[WSHandler] RX: a7 b3 04 d9 82 9e b0 f1 a0 00 0f e5
[WSHandler] WebSocket closed
[Session:127.0.0.1-chrome-OXNC] Removed WebSocket (0 active)
[Session:127.0.0.1-chrome-OXNC] Starting 60s grace period
[SharedState] 📊 State updated: {"connected":true,"deviceName":"6c79b82603a7","recovering":false,"connectedAt":"2025-08-01T12:00:17.847Z"} → {"connected":true,"deviceName":"6c79b82603a7","recovering":false,"connectedAt":"2025-08-01T12:00:27.316Z"}
[Bridge] New WebSocket connection for session: 127.0.0.1-chrome-TA1F
[SessionManager] Rejecting new session 127.0.0.1-chrome-TA1F - device busy with session 127.0.0.1-chrome-OXNC (grace period: true)
[SessionManager] Session 127.0.0.1-chrome-OXNC - WebSockets: 0, Idle: 18s, Grace: true
[SessionManager] Session 127.0.0.1-chrome-OXNC - WebSockets: 0, Idle: 48s, Grace: true

### console log from test session
● Here's the complete console log from the v0.5.3 test for your bug report:

  === Test 1: First Connection (Success) ===
  [Console LOG] [WebBleMock] Bundle loaded successfully, version: 0.5.3, exports:
  [MockBluetooth, injectWebBluetoothMock, updateMockConfig, clearStoredSession,
  testSessionPersistence, getBundleVersion, version]
  [Console LOG] [MockBluetooth] Generated new session: 127.0.0.1-chrome-OXNC (IP:
  127.0.0.1, Browser: chrome)
  [Console LOG] [MockBluetooth] Stored new session: 127.0.0.1-chrome-OXNC
  [Console LOG] [MockBluetooth] localStorage available: true, context:
  http://localhost:5173
  [Console LOG] [WebBLE Adapter] Injected ble-mcp-test mock with URL:
  ws://192.168.50.73:8080/?device=6c79b82603a7&service=9800&write=9900&notify=9901
  [Console LOG] [WebBLE Adapter] navigator.bluetooth is now available
  [Console DEBUG] [DeviceStore] Reader state change: DISCONNECT -> CONNECTING
  [Console LOG] [MockGATT] Using session ID for WebSocket: 127.0.0.1-chrome-OXNC
  [Console LOG] [MockGATT] WebSocket connect options: {"device":"6c79b82603a7","sessio
  nId":"127.0.0.1-chrome-OXNC","session":"127.0.0.1-chrome-OXNC"}
  [Console INFO] Connected to 6c79b82603a7
  [Console DEBUG] [DeviceStore] Reader state change: CONNECTING -> CONFIGURING
  [Console INFO] Initializing RFID module
  [Console DEBUG] Battery auto reporting started
  [Console DEBUG] [DeviceManager] Setting state to IDLE after successful connection
  [Console DEBUG] [DeviceStore] Reader state change: CONFIGURING -> IDLE

  === Page Reload ===

  === Test 2: After Reload (Failed) ===
  [Console LOG] [WebBleMock] Bundle loaded successfully, version: 0.5.3, exports:
  [MockBluetooth, injectWebBluetoothMock, updateMockConfig, clearStoredSession,
  testSessionPersistence, getBundleVersion, version]
  [Console LOG] [MockBluetooth] Reusing stored session: 127.0.0.1-chrome-OXNC
  [Console LOG] [MockBluetooth] localStorage available: true, context:
  http://localhost:5173
  [Console LOG] [WebBLE Adapter] Injected ble-mcp-test mock with URL:
  ws://192.168.50.73:8080/?device=6c79b82603a7&service=9800&write=9900&notify=9901
  [Console LOG] [WebBLE Adapter] navigator.bluetooth is now available
  [Console DEBUG] [DeviceStore] Reader state change: DISCONNECT -> CONNECTING
  [Console LOG] [MockGATT] Using session ID for WebSocket: 127.0.0.1-chrome-OXNC
  [Console LOG] [MockGATT] WebSocket connect options: {"device":"6c79b82603a7","sessio
  nId":"127.0.0.1-chrome-OXNC","session":"127.0.0.1-chrome-OXNC"}
  [Console ERROR] BLE connection error: Error: Device is busy with another session
  [Console ERROR] Transport error: Connection error: Device is busy with another
  session
  [Console ERROR] RFID Module: Error - Connection error: Device is busy with another
  session
  [Console DEBUG] [DeviceStore] Reader state change: CONNECTING -> DISCONNECT
  [Console ERROR] Failed to connect: Error: Connection timeout - device not found or
  not responding
  [Console ERROR] Connection error: Error: Connection timeout - device not found or
  not responding

## OTHER CONSIDERATIONS:
- Piggyback changes to /execute-prp command .claude/commands/execute-prp.md
- Move completed prp specs and prompts to archive
- This will be a patch version likely 0.5.4
