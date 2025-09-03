# Bridge Server Fix Requirements

**Issue:** E2E connection tests failing due to incomplete Web Bluetooth mock implementation

**Status:** Bridge server WebSocket connection hangs, Web Bluetooth Service mock missing critical methods

## Problem Summary

The bridge server's Web Bluetooth mock successfully handles device discovery and GATT connection, but fails during characteristic discovery. This causes our connection flow to get stuck in "Connecting..." state.

## Test Results

### ✅ Working Components
- Mock injection: `Mock injected: true`
- Device discovery: `Device found: CS108 Reader`
- GATT connection: `GATT connected: true`
- Primary service discovery: `Service UUID: 0000fee0-0000-1000-8000-00805f9b34fb`

### ❌ Failing Components
- **WebSocket connection**: Times out completely (30+ seconds)
- **Characteristic discovery**: `service.getCharacteristics is not a function`

## Required Fixes

### 1. WebSocket Connection Handler
**Problem:** Bridge server not accepting WebSocket connections on `ws://192.168.50.73:8080`

**Expected Behavior:**
```javascript
// Should respond to these WebSocket messages:
{
  type: 'session',
  sessionId: 'bridge-test-session'
}

{
  type: 'scan', 
  duration: 2000
}

{
  type: 'connect',
  deviceName: 'CS108 Reader'
}

{
  type: 'write',
  data: 'A7B3180000000A0D'
}
```

### 2. Web Bluetooth Service Mock - Missing Methods

**Problem:** `BluetoothRemoteGATTService.prototype.getCharacteristics` is not implemented

**Required Implementation:**
```javascript
// service.getCharacteristics() should return:
[
  {
    uuid: "0000fee1-0000-1000-8000-00805f9b34fb", // Write characteristic
    properties: {
      write: true,
      writeWithoutResponse: true,
      notify: false
    },
    writeValue: async (data) => {
      // Forward to WebSocket bridge
    }
  },
  {
    uuid: "0000fee2-0000-1000-8000-00805f9b34fb", // Notify characteristic  
    properties: {
      write: false,
      writeWithoutResponse: false,
      notify: true
    },
    startNotifications: async () => {
      // Set up notification forwarding
    },
    addEventListener: (event, handler) => {
      // Handle characteristicvaluechanged events
    }
  }
]
```

## CS108 Protocol Requirements

### Write Characteristic (0000fee1-...)
- Must accept Uint8Array writes
- Forward commands to physical CS108 device
- Examples:
  - Battery: `A7B3180000000A0D`
  - RFID Power On: `A7B3700100000171`
  - Start Inventory: `A7B3F000000157`

### Notify Characteristic (0000fee2-...)
- Must emit `characteristicvaluechanged` events
- Forward responses from physical CS108 device
- Examples:
  - Battery Response: `B3A7180100xx4F` (xx = battery level)
  - Tag Data: `B3A790...` (variable length)

## Test Validation

The fix should allow this test sequence to complete:
1. WebSocket connects to bridge
2. Session establishment 
3. BLE device scan finds CS108
4. GATT connection succeeds
5. Service discovery finds fee0 service
6. **Characteristic discovery finds fee1/fee2 characteristics** ← Currently failing
7. Write battery command to fee1
8. Receive battery response on fee2 notifications

## Priority

**HIGH** - Blocking all E2E connection tests. Without characteristic discovery, the connection flow cannot complete.

## Files for Reference

- Test file: `prp/example/bridge-direct.spec.ts`
- Connection helper: `prp/example/connection.ts`
- Transport manager: `prp/example/transportManager.ts`

## Expected Timeline

This should be a straightforward fix - adding the missing `getCharacteristics()` method and ensuring WebSocket accepts connections. Estimated: 1-2 hours.
