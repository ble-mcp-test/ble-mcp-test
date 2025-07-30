# BLE Bridge Connection Lifecycle

## Overview
This document describes the complete lifecycle of a BLE connection through the WebSocket bridge, from client connection to disconnection.

## Connection Flow

### 1. Client Connects via WebSocket
```
Client → WebSocket → BridgeServer
```
- Client connects to `ws://localhost:8080`
- Sends connection request with BLE parameters:
  ```json
  {
    "type": "connect",
    "devicePrefix": "CS108",
    "serviceUuid": "9800",
    "writeUuid": "9900",
    "notifyUuid": "9901"
  }
  ```

### 2. BridgeServer Initiates BLE Connection
```
BridgeServer → NobleTransport → Noble → BLE Device
```
- BridgeServer creates/reuses NobleTransport instance
- Calls `transport.connect(bleConfig, callbacks)`
- NobleTransport begins scanning for matching device

### 3. Device Discovery & Connection
```
NobleTransport.connect() executes:
```
1. **Scan Phase**
   - `noble.startScanningAsync()` 
   - `noble.discoverAsync()` generator to find devices
   - Match by device name prefix
   - `noble.stopScanningAsync()` when found

2. **Connection Phase**
   - `peripheral.connectAsync()`
   - Wait for stability delay (platform-specific)
   - `peripheral.discoverServicesAsync()`
   - `service.discoverCharacteristicsAsync()`
   - Store write and notify characteristics

3. **Notification Setup**
   - Add data listener: `notifyChar.on('data', callback)`
   - Subscribe to notifications: `notifyChar.subscribeAsync()`
   - Register disconnect handler: `peripheral.once('disconnect', callback)`

### 4. Data Flow
```
BLE Device ←→ Noble ←→ NobleTransport ←→ BridgeServer ←→ WebSocket ←→ Client
```

**Receive (RX):**
- BLE device sends notification
- Noble emits 'data' event on characteristic
- NobleTransport callback → `onData()`
- BridgeServer logs to buffer and forwards via WebSocket

**Transmit (TX):**
- Client sends data via WebSocket
- BridgeServer logs to buffer
- Calls `transport.sendData()`
- NobleTransport writes to characteristic

### 5. Disconnection Paths

**Normal Disconnect:**
- Client disconnects WebSocket OR sends disconnect message
- BridgeServer calls `transport.disconnect()`
- NobleTransport:
  - `notifyChar.unsubscribeAsync()`
  - `peripheral.disconnectAsync()`
  - Clear all references

**Unexpected Disconnect:**
- BLE device disconnects
- Noble emits 'disconnect' event
- NobleTransport cleanup (⚠️ missing unsubscribe)
- Callback → `onDisconnected()`
- BridgeServer closes WebSocket

**Error During Connection:**
- Any step fails in connect()
- Catch block executes:
  - `notifyChar.unsubscribeAsync()` (✅ fixed)
  - Remove all listeners
  - `peripheral.disconnectAsync()`
  - Clear references
  - Throw error to BridgeServer

## Root Cause Analysis: Ghost Notifications

### The Problem
RX data was appearing during unrelated operations (like scanning) because of orphaned BLE notification subscriptions.

### Why It Happened
1. **Two-Level Cleanup Required:**
   - JavaScript level: Event listeners (`on('data')`)
   - BLE protocol level: Notification subscription

2. **Incomplete Cleanup:**
   - `removeAllListeners()` only cleans JavaScript level
   - `unsubscribeAsync()` required for BLE level
   - Error path was missing the unsubscribe call

3. **Sequence of Events:**
   ```
   Connection attempt → Subscribe to notifications → Error occurs →
   Clean up listeners (JS) → [MISSING: Unsubscribe from BLE] →
   Clear references → BLE device keeps sending → Noble keeps receiving →
   Data appears during next operation
   ```

### The Fix
Added `await notifyChar.unsubscribeAsync()` in the error cleanup path before clearing the reference.

## Key Timing Considerations

### Platform-Specific Delays
- **macOS**: No delays needed
- **Linux**: 100ms stability, 100ms pre-discovery
- **Raspberry Pi**: 200ms stability, 200ms pre-discovery

### Dynamic Cooldowns
- Base disconnect cooldown: 200ms
- Scales up to 2200ms under pressure
- Prevents rapid reconnection issues

### Cleanup Timing
1. Always unsubscribe before removing listeners
2. Always remove listeners before clearing references
3. Handle all async operations in try-catch
4. Don't assume peripheral is still valid

## Common Issues

### Listener Accumulation
- Noble's `discoverAsync()` leaks scanStop listeners
- Manual cleanup required during long scans
- Monitor listener counts for pressure

### Early Disconnects
- Device reports connected but immediately disconnects
- Usually caused by:
  - Too rapid reconnection
  - Previous connection not fully cleaned
  - BLE stack issues

### Race Conditions
- Avoid making disconnect handler async
- Complete all cleanup before starting new operations
- Use state machine to prevent concurrent operations