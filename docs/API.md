# API Documentation

## Browser API

### injectWebBluetoothMock(config: WebBleMockConfig)

Replaces the browser's `navigator.bluetooth` with a mock that communicates with the bridge server.

```typescript
export interface WebBleMockConfig {
  sessionId: string;      // REQUIRED - session management
  serverUrl: string;      // REQUIRED - bridge server URL  
  service: string;        // REQUIRED - primary service UUID
  write?: string;         // OPTIONAL - write characteristic UUID
  notify?: string;        // OPTIONAL - notify characteristic UUID
  deviceId?: string;      // OPTIONAL - specific device ID
  deviceName?: string;    // OPTIONAL - device name filter
  timeout?: number;       // OPTIONAL - discovery timeout (default: 5000ms)
  onMultipleDevices?: 'error' | 'first';  // OPTIONAL - multiple device behavior (default: 'error')
}
```

```javascript
import { injectWebBluetoothMock } from 'ble-mcp-test/browser';

// Basic usage (all required parameters)
injectWebBluetoothMock({
  sessionId: `myapp-e2e-${os.hostname()}`,  // Required: unique session ID
  serverUrl: 'ws://localhost:8080',         // Required: bridge server URL
  service: '9800'                           // Required: primary service UUID
});

// With optional characteristics
injectWebBluetoothMock({
  sessionId: `myapp-e2e-${os.hostname()}`,
  serverUrl: 'ws://localhost:8080',
  service: '9800',
  write: '9900',      // Optional: write characteristic
  notify: '9901'      // Optional: notify characteristic
});

// With device selection (for multi-device environments)
injectWebBluetoothMock({
  sessionId: `farm-${deviceId}-${os.hostname()}`,
  serverUrl: 'ws://device-farm:8080',
  service: '9800',
  deviceId: '6c79b8xxxxxx'  // Connect to specific device
});

```

#### Parameters

- **sessionId** (required): Unique identifier for session management. Prevents connection conflicts and enables connection reuse across test runs.
  - **Best Practice**: Include app name and hostname: `myapp-e2e-${os.hostname()}`
  - Makes it easy to identify which machine has the connection in bridge logs
  - Example: `"e2e-test-session-bt-sandbox"`, `"ci-job-123-github-runner-04"`
- **serverUrl** (required): WebSocket URL of the bridge server (e.g., `ws://localhost:8080`).
- **service** (required): Primary BLE service UUID for device discovery. Used to filter devices during scanning.
- **write** (optional): Characteristic UUID for write operations. Defaults to device's primary write characteristic.
- **notify** (optional): Characteristic UUID for notifications. Defaults to device's primary notify characteristic.
- **deviceId** (optional): Specific device ID to connect to. Useful in device farm environments with multiple identical devices.
- **deviceName** (optional): Device name filter for device selection.
- **timeout** (optional): Device discovery timeout in milliseconds. Default: 5000ms.
- **onMultipleDevices** (optional): Behavior when multiple devices match filters. `'error'` (default) throws error, `'first'` connects to first found.

#### Error Handling

The function throws clear errors for missing required parameters:

```javascript
// Missing sessionId
injectWebBluetoothMock({
  serverUrl: 'ws://localhost:8080',
  service: '9800'
});
// Error: sessionId is required - this prevents session conflicts and ensures predictable BLE connection management

// Missing serverUrl
injectWebBluetoothMock({
  sessionId: `myapp-e2e-${os.hostname()}`,
  service: '9800'
});
// Error: serverUrl is required - specify the bridge server URL (e.g., "ws://localhost:8080")

// Missing service
injectWebBluetoothMock({
  sessionId: `myapp-e2e-${os.hostname()}`,
  serverUrl: 'ws://localhost:8080'
});
// Error: service is required - specify the primary service UUID for device discovery
```

#### Additional Notes

- All three parameters (sessionId, serverUrl, service) are required as of v0.6.0
- The sessionId should be unique per test run/developer machine
- Include hostname in sessionId for easier debugging
- Service UUID is used for device discovery filtering

### Using the Browser Bundle

If you're not using a module bundler, include the pre-built bundle:

```html
<script src="path/to/web-ble-mock.bundle.js"></script>
<script>
  // Global WebBleMock object is available
  WebBleMock.injectWebBluetoothMock({
    sessionId: `myapp-browser-${window.location.hostname}`,
    serverUrl: 'ws://localhost:8080',
    service: '9800'
  });
</script>
```

### Mock Configuration

The mock supports configuration via environment variables for retry behavior:

- `BLE_MCP_MOCK_RETRY_DELAY` - Initial retry delay in ms (default: 1000)
- `BLE_MCP_MOCK_MAX_RETRIES` - Maximum retry attempts (default: 10)
- `BLE_MCP_MOCK_CLEANUP_DELAY` - Post-disconnect delay in ms (default: 0)
- `BLE_MCP_MOCK_BACKOFF` - Exponential backoff multiplier (default: 1.5)
- `BLE_MCP_MOCK_LOG_RETRIES` - Log retry attempts (default: true)

### Test Notification Injection

The `simulateNotification()` method allows tests to inject device notifications without real hardware events:

```javascript
// Use the testing API (available after mock injection)
const { simulateNotification } = navigator.bluetooth.testing;

// Get a characteristic through normal API
const characteristic = await service.getCharacteristic('9901');

// Simulate a button press event from the device
await simulateNotification({
  characteristic: characteristic,
  data: new Uint8Array([0xA7, 0xB3, 0x01, 0xFF])
});

// Simulate a button release event
await simulateNotification({
  characteristic: characteristic,
  data: new Uint8Array([0xA7, 0xB3, 0x01, 0x00])
});
```

#### Debug Logging (v0.7.2+)

The `simulateNotification()` method provides comprehensive console logging for debugging:

```javascript
// Each call to simulateNotification() will log:
// 1. "ble-mcp-test: dispatching notify event" with details
// 2. "ble-mcp-test: notify event dispatched successfully" on completion
```

Console output example:
```
ble-mcp-test: dispatching notify event {
  characteristic: "0000-9901-0000-1000-8000-00805f9b34fb",
  dataLength: 4,
  data: "0xa7 0xb3 0x01 0xff"
}
ble-mcp-test: notify event dispatched successfully
```

This is useful for:
- Testing notification handlers without real device events
- Controlling exact timing of test events
- Simulating specific device states or error conditions
- Testing while the real device is performing other operations

## Node.js API

### NodeBleClient

A clean, Node.js BLE client that communicates with real BLE devices through the bridge server. 

#### Constructor

```typescript
import { NodeBleClient } from 'ble-mcp-test/node';

const client = new NodeBleClient(options: NodeBleClientOptions);
```

#### Options Interface

```typescript
interface NodeBleClientOptions {
  sessionId: string;              // REQUIRED - unique session identifier
  bridgeUrl: string;              // REQUIRED - WebSocket bridge URL
  service: string;                // REQUIRED - Service UUID for discovery
  write: string;                  // REQUIRED - Write characteristic UUID
  notify: string;                 // REQUIRED - Notify characteristic UUID
  deviceId?: string;              // OPTIONAL - Exact device ID for filtering
  deviceName?: string;            // OPTIONAL - Partial device name for filtering
  debug?: boolean;                // OPTIONAL - Enable debug logging
  timeout?: number;               // OPTIONAL - Connection timeout
  reconnectAttempts?: number;     // OPTIONAL - Number of reconnection attempts (default: 3)
  reconnectDelay?: number;        // OPTIONAL - Initial reconnection delay in ms (default: 1000)
}
```

#### Basic Usage

```javascript
import { NodeBleClient } from 'ble-mcp-test/node';
import os from 'os';

// Create client with required parameters
const client = new NodeBleClient({
  sessionId: `my-app-${os.hostname()}`,         // REQUIRED - prevents session conflicts
  bridgeUrl: 'ws://localhost:8080',             // REQUIRED - bridge server URL
  service: '9800',                              // REQUIRED - primary service UUID
  write: '9900',                                // REQUIRED - write characteristic
  notify: '9901',                               // REQUIRED - notify characteristic
  debug: true
});

// Connect to bridge and BLE device in one call
await client.connect();

// Option 1: Simple request/response pattern (recommended)
const command = new Uint8Array([0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00]);
const response = await client.sendCommandAsync(command);
console.log('Response:', Array.from(response).map(b => b.toString(16).padStart(2, '0')).join(' '));

// Option 2: Manual notification handling for ongoing device events
client.onNotification((data) => {
  console.log('Device notification:', Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' '));
});
await client.writeValue(command);

// Cleanup
await client.disconnect();
```

#### Device Filtering (Optional)

For environments with multiple BLE devices:

```javascript
// Filter by exact device ID
const client = new NodeBleClient({
  sessionId: 'device-farm-session',
  bridgeUrl: 'ws://device-farm:8080',
  service: '9800',
  write: '9900',
  notify: '9901',
  deviceId: '6c79b8xxxxxx'  // Connect to specific device
});

// Filter by device name (partial match)
const client = new NodeBleClient({
  sessionId: 'lab-session',
  bridgeUrl: 'ws://localhost:8080',
  service: '9800',
  write: '9900',
  notify: '9901',
  deviceName: 'Test Device'  // Matches any device containing "Test Device"
});
```

#### Methods

**`async connect(): Promise<void>`**
- Establishes WebSocket connection to bridge and connects to BLE device
- Single call replaces multi-step Web Bluetooth ceremony
- Throws error if connection fails or times out

**`async writeValue(data: Uint8Array): Promise<void>`**
- Sends data directly to the BLE device's write characteristic
- Throws error if not connected or write fails
- No need to get characteristic objects

**`onNotification(handler: (data: Uint8Array) => void): void`**
- Sets up notification handler for incoming BLE data
- Handler receives raw Uint8Array data from device
- Replaces characteristic.addEventListener pattern

**`async sendCommandAsync(command: Uint8Array, timeoutMs?: number): Promise<Uint8Array>`**
- **NEW**: Combined send-command-and-wait-for-response method
- Sends command to device and awaits single response notification
- Returns device response as Uint8Array
- Default timeout: 5000ms (configurable)
- Ideal for request/response patterns (recommended approach)
- Temporarily overrides notification handler during command execution

**`async disconnect(): Promise<void>`**
- Cleanly disconnects from BLE device and closes WebSocket
- Safe to call multiple times

**`async destroy(): Promise<void>`**
- Performs disconnect and removes all event listeners
- Call when permanently done with client

**`isConnected(): boolean`**
- Returns true if both WebSocket and BLE connections are active

**`getSessionId(): string`**
- Returns the session ID used for this client

**`getAvailability(): Promise<boolean>`**
- Always returns true (bridge makes BLE available)

#### Error Handling

The client throws descriptive errors for common issues:

```javascript
try {
  const client = new NodeBleClient({
    // Missing sessionId
    bridgeUrl: 'ws://localhost:8080',
    service: '9800',
    write: '9900',
    notify: '9901'
  });
} catch (error) {
  // Error: sessionId is required - this prevents session conflicts and ensures predictable BLE connection management
}

try {
  await client.writeValue(data);
} catch (error) {
  if (error.message.includes('Client not connected')) {
    console.log('Need to call connect() first');
  } else if (error.message.includes('Connection timeout')) {
    console.log('Bridge server may not be running');
  }
}
```

#### API Features

- **Service-UUID Discovery**: Fast, reliable device connection using service UUIDs
- **Single Connect**: One call establishes complete WebSocket + BLE connection  
- **Session Management**: Required `sessionId` prevents connection conflicts
- **Optional Filtering**: Filter by exact `deviceId` or partial `deviceName` when needed

## WebSocket Protocol

### Connection Parameters

Pass device configuration via URL query parameters:

| Parameter | Description | Example |
|-----------|-------------|---------|
| `device` | Device name prefix to search for | `CS108` |
| `service` | BLE service UUID | `9800` or `00009800-0000-1000-8000-00805f9b34fb` |
| `write` | Write characteristic UUID | `9900` |
| `notify` | Notify characteristic UUID | `9901` |
| `session` | Session ID for connection persistence (v0.5.0+) | `my-app-session-123` |
| `force` | Force takeover of busy device (v0.5.1+) | `true` |

**Example URLs:**
```
ws://localhost:8080?device=CS108&service=9800&write=9900&notify=9901
ws://localhost:8080?session=my-app-session-123
ws://localhost:8080?device=CS108&session=persist-123&service=9800
ws://localhost:8080?device=CS108&service=9800&write=9900&notify=9901&force=true
```

Add `role=observer` to attach read-only to the current writer's notification
stream. See **Session Management** below for what each of `session`, `force` and
`role` actually guarantees.

### Message Format

The wire protocol is specified in
[`docs/design/2026-08-23-ws-protocol-spec.md`](design/2026-08-23-ws-protocol-spec.md),
which is the acceptance criterion for the bridge. That document governs; this
file does not restate it, because two copies of a protocol drift and only one
of them is checked.

## Web Bluetooth API Support

The mock implements the following Web Bluetooth API methods:

### navigator.bluetooth.requestDevice()
- Supports `filters` with `namePrefix`
- Supports `optionalServices`
- Returns a `BluetoothDevice` object

### BluetoothDevice
- `name` - Device name
- `gatt` - GATT server interface

### BluetoothRemoteGATTServer
- `connect()` - Connect to device
- `disconnect()` - Disconnect from device
- `getPrimaryService(uuid)` - Get a service

### BluetoothRemoteGATTService
- `getCharacteristic(uuid)` - Get a characteristic

### BluetoothRemoteGATTCharacteristic
- `writeValue(data)` - Write data to characteristic
- `startNotifications()` - Enable notifications
- `addEventListener('characteristicvaluechanged', handler)` - Listen for notifications
- Available via `navigator.bluetooth.testing.simulateNotification()` - Inject test notifications

## Mock Configuration API (v0.4.3+)

The mock can be configured at runtime using the `updateMockConfig` function:

```javascript
import { updateMockConfig } from 'ble-mcp-test/browser';

// Configure retry behavior
updateMockConfig({
  connectRetryDelay: 200,    // Initial retry delay in ms
  maxConnectRetries: 10,     // Maximum retry attempts
  postDisconnectDelay: 0,    // Delay after disconnect
  retryBackoffMultiplier: 1.3, // Exponential backoff factor
  logRetries: true           // Log retry attempts
});
```

### Configuration Options

- `connectRetryDelay` (default: 1200ms) - Initial delay before first retry
- `maxConnectRetries` (default: 20) - Maximum number of connection retry attempts
- `postDisconnectDelay` (default: 1100ms) - Wait time after disconnect before allowing reconnect
- `retryBackoffMultiplier` (default: 1.3) - Multiplier for exponential backoff between retries
- `logRetries` (default: true) - Whether to log retry attempts to console

## Session Management

> **Rewritten for the current bridge.** This section previously described BLE
> connections persisting across WebSocket disconnects, a 60-second grace period,
> session reuse and recovery, and multiple WebSockets sharing one BLE session. None
> of that is how the bridge works, and the two variables it named —
> `BLE_SESSION_GRACE_PERIOD_SEC` and `BLE_SESSION_IDLE_TIMEOUT_SEC` — are read by
> no code in this repository. The pooling model was deliberately replaced: one
> transport per connection, released in `finally`.

### Session behaviour

- **Session ID**: pass `?session=<id>` in the WebSocket URL. Two layers differ
  here, deliberately. The **bridge** treats it as optional and generates a UUID
  when it is absent, so a hand-rolled client still connects. The **mock**
  (`injectWebBluetoothMock`) *requires* `sessionId` and throws without it, because
  a generated id is invisible to the test that owns it: a value the client never
  chose and cannot see is what lets two runs share a device while both look
  correctly configured. The session id is a label for diagnostics and refusal
  messages, not a lock — see the next bullet.
- **One writer at a time**: the command path is single-writer and the claim is *per
  connection*, not per session. A second writer is refused with a `Device is busy`
  error naming the holder — including when both connections carry the same session
  id. Two writers on one reader is the hazard the model exists to prevent: with no
  op-code correlation, client A's response settles client B's pending command, and
  neither client is slow or sees an error.
- **Observers**: connect with `role=observer` to attach read-only to the current
  writer's notification stream. An observer builds no transport and holds no
  device. A write from an observer is refused and discarded, and the connection
  stays open.
- **Takeover**: connect with `force=true` to displace the current writer. The
  evicted connection is sent an `error` explaining why its stream ended; the
  displacing connection is sent a `warning`, before `connected`, saying the run it
  interrupted is now invalid.
- **Release is immediate**: when a writer's socket closes, the device link is
  released. No grace period, no pooling, no recovery window. A bridge that is
  merely running holds no radio.
- **Idle timeout**: a writer that sends nothing for `BLE_MCP_IDLE_TIMEOUT` seconds
  (default 600) has its device link and command path released, is told so in an
  `error` frame, and the release is logged. Only frames *from the client* renew the
  lease — device notifications never do, because the reader emits unprompted
  traffic on its own timers and an abandoned session would otherwise renew its own
  lease forever. See `.env.local.example` for the reasoning and the citations.

### Configuration
- `BLE_MCP_IDLE_TIMEOUT` — seconds of no inbound frame before a writer is released
  (default: 600; `0` disables it).

## Limitations

### Single Connection
The bridge currently supports **one BLE connection at a time**. If a WebSocket client tries to connect while another client has an active BLE connection, it will receive an error:

```json
{
  "type": "error",
  "error": "Another connection is active"
}
```

This is by design to prevent race conditions and ensure reliable operation. See the [Roadmap](../README.md#roadmap) for planned multi-device support.

## Error Handling

The bridge provides clear error messages:

- `"No device found"` - No BLE device matching the criteria was found
- `"Missing required parameters"` - URL parameters are incomplete
- `"Another connection is active"` - Bridge is already connected to a device
- `"Failed to connect to WebSocket server"` - Can't reach the bridge server

## Example: Complete Test

```javascript
import { test } from '@playwright/test';

test('communicate with BLE device', async ({ page }) => {
  // Load your application
  await page.goto('http://localhost:3000');
  
  // Inject the mock
  await page.addScriptTag({ 
    path: 'node_modules/ble-mcp-test/dist/web-ble-mock.bundle.js' 
  });
  
  // Configure and initialize
  await page.evaluate((hostname) => {
    WebBleMock.injectWebBluetoothMock({
      sessionId: `myapp-e2e-${hostname}`,
      serverUrl: 'ws://localhost:8080',
      service: '9800',
      write: '9900',
      notify: '9901'
    });
  }, os.hostname());
  
  // Now your app can use navigator.bluetooth normally!
  await page.click('#connect-button');
  await page.waitForSelector('#connected-status');
});
```
