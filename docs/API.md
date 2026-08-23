# API Documentation

## Server API

### BridgeServer

The main WebSocket bridge server class.

```javascript
import { BridgeServer } from 'ble-mcp-test';

const server = new BridgeServer();
server.start(8080); // Start on port 8080

// Later...
server.stop(); // Graceful shutdown
```

#### Methods

- `start(port?: number)` - Start the WebSocket server (default port: 8080)
- `stop()` - Stop the server and close all connections

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
import { injectWebBluetoothMock } from 'ble-mcp-test';

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

## MCP HTTP Endpoints

When running with HTTP transport (`pnpm start:http` or `--mcp-http`), the following endpoints are available:

### GET /mcp/info

Public endpoint that returns server metadata and available tools. No authentication required.

**Response:**
```json
{
  "name": "ble-mcp-test",
  "version": "0.4.2",
  "description": "Bridge Bluetooth devices to your AI coding assistant via Model Context Protocol",
  "tools": [
    { "name": "get_logs", "description": "Get BLE Communication Logs" },
    { "name": "search_packets", "description": "Search BLE Packets" },
    { "name": "get_connection_state", "description": "Get Connection State" },
    { "name": "status", "description": "Get Bridge Server Status" },
    { "name": "scan_devices", "description": "Scan for BLE Devices" }
  ]
}
```

**Headers:**
- `Cache-Control: public, max-age=3600` - Cacheable for 1 hour

### POST /mcp/register

Authenticated endpoint for MCP client registration. Returns server capabilities.

**Headers Required:**
- `Authorization: Bearer <token>` - Required if BLE_MCP_HTTP_TOKEN is set

**Response:**
```json
{
  "name": "ble-mcp-test",
  "version": "0.4.2",
  "capabilities": {
    "tools": true,
    "resources": false,
    "prompts": false
  }
}
```

**Headers:**
- `Cache-Control: no-cache, no-store, must-revalidate` - Not cacheable

### POST /mcp

Main MCP message handling endpoint. Processes MCP protocol messages.

**Headers:**
- `Authorization: Bearer <token>` - Required if BLE_MCP_HTTP_TOKEN is set
- `Content-Type: application/json`
- `Mcp-Session-Id: <session-id>` - Optional session identifier

### GET /mcp

Server-Sent Events (SSE) endpoint for streaming MCP responses.

**Headers:**
- `Authorization: Bearer <token>` - Required if BLE_MCP_HTTP_TOKEN is set
- `Mcp-Session-Id: <session-id>` - Required session identifier

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

### Message Format

All messages are JSON objects with a `type` field.

#### Client → Server Messages

**Send data to BLE device:**
```json
{
  "type": "data",
  "data": [0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00]
}
```

**Graceful disconnect:**
```json
{
  "type": "disconnect"
}
```

**Complete BLE cleanup:**
```json
{
  "type": "cleanup"
}
```

**Force cleanup with token (v0.4.0):**
```json
{
  "type": "force_cleanup",
  "token": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Force cleanup all sessions (v0.5.1):**
```json
{
  "type": "force_cleanup",
  "all_sessions": true
}
```

**Admin cleanup (v0.5.1):**
```json
{
  "type": "admin_cleanup",
  "auth": "your-admin-token",
  "action": "cleanup_all"
}
```

**Keep connection alive (v0.4.0):**
```json
{
  "type": "keepalive"
}
```

**Check Noble.js pressure:**
```json
{
  "type": "check_pressure"
}
```

#### Server → Client Messages

**Device connected (v0.4.0 - includes token):**
```json
{
  "type": "connected",
  "device": "CS108ReaderXXXXXX",
  "token": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Data received from device:**
```json
{
  "type": "data",
  "data": [0xA7, 0xB3, 0x04, 0xD9, 0x82, 0x9E, 0xF7, 0xDD, 0xA0, 0x00, 0x0F, 0xF0]
}
```

**Error occurred:**
```json
{
  "type": "error",
  "error": "No device found"
}
```

**Session blocked error (v0.5.1):**
```json
{
  "type": "error",
  "error": "Device is busy with another session",
  "blocking_session_id": "cs108-session-abc123",
  "device": "CS108"
}
```

**Device disconnected:**
```json
{
  "type": "disconnected"
}
```

**Eviction warning (v0.4.0):**
```json
{
  "type": "eviction_warning",
  "grace_period_ms": 5000,
  "reason": "idle_timeout"
}
```

**Keepalive acknowledgment (v0.4.0):**
```json
{
  "type": "keepalive_ack",
  "timestamp": "2025-01-30T12:34:56.789Z"
}
```

**Cleanup complete:**
```json
{
  "type": "cleanup_complete",
  "message": "BLE cleanup completed successfully"
}
```

**Force cleanup complete (v0.4.0):**
```json
{
  "type": "force_cleanup_complete",
  "message": "Noble force cleanup completed successfully"
}
```

**Pressure report:**
```json
{
  "type": "pressure_report",
  "pressure": {
    "scanStopListeners": 0,
    "peripheralListeners": 2,
    "isUnderPressure": false
  }
}
```

**Health check (v0.4.0 - enhanced):**
```json
{
  "type": "health",
  "status": "ok",
  "free": true,
  "state": "IDLE",
  "transportState": "disconnected",
  "connectionInfo": null,
  "timestamp": "2025-01-30T12:34:56.789Z"
}
```

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
import { updateMockConfig } from 'ble-mcp-test';

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

## Session Management (v0.5.0+)

Sessions allow BLE connections to persist across WebSocket disconnects:

### Session Behavior
- **Session ID**: Pass `?session=<id>` in WebSocket URL to use a specific session
- **Grace Period**: BLE connections persist for 60 seconds after WebSocket disconnect (configurable via `BLE_SESSION_GRACE_PERIOD_SEC`)
- **Idle Timeout**: Sessions auto-cleanup after 5 minutes of inactivity (configurable via `BLE_SESSION_IDLE_TIMEOUT_SEC`)
- **Multiple WebSockets**: Multiple WebSocket clients can share the same BLE session
- **Backward Compatible**: Works without session parameters for existing clients

### Session Lifecycle
1. **Session Creation**: First WebSocket with a session ID creates the BLE session
2. **Session Reuse**: Subsequent WebSockets with same ID reuse existing BLE connection
3. **Grace Period**: When last WebSocket disconnects, BLE connection enters grace period
4. **Session Recovery**: New WebSocket within grace period resumes the session
5. **Session Cleanup**: After grace period expires, BLE connection is terminated

### Configuration
- `BLE_SESSION_GRACE_PERIOD_SEC` - Grace period in seconds (default: 60)
- `BLE_SESSION_IDLE_TIMEOUT_SEC` - Idle timeout in seconds (default: 300)

## Connection Token
All successful connections now receive a unique authentication token:
- The `connected` message includes a `token` field
- This token is required for `force_cleanup` operations
- Token format: UUID v4 (e.g., `550e8400-e29b-41d4-a716-446655440000`)

### State Machine
The server uses an atomic state machine for connection lifecycle:
- **ready**: No active connections, ready to accept new connections
- **connecting**: Establishing BLE connection
- **active**: Connection established and operational
- **disconnecting**: Cleaning up connection

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

## Utility Functions

The bridge server exports several utility functions for working with BLE data and logging:

### formatHex(data: Uint8Array | Buffer): string

Formats binary data as uppercase hexadecimal with space separation.

```typescript
import { formatHex } from 'ble-mcp-test';

const data = new Uint8Array([0xA7, 0xB3, 0xC2, 0x01]);
console.log(formatHex(data)); // "A7 B3 C2 01"

const buffer = Buffer.from([0x12, 0x34, 0x56, 0x78]);
console.log(formatHex(buffer)); // "12 34 56 78"
```

### normalizeLogLevel(level?: string): LogLevel

Normalizes log level strings to a valid LogLevel type, with support for common aliases.

```typescript
import { normalizeLogLevel } from 'ble-mcp-test';

normalizeLogLevel('debug');    // 'debug'
normalizeLogLevel('verbose');  // 'debug' (alias)
normalizeLogLevel('trace');    // 'debug' (alias)
normalizeLogLevel('info');     // 'info'
normalizeLogLevel('warn');     // 'info' (mapped to info)
normalizeLogLevel('warning');  // 'info' (alias)
normalizeLogLevel('error');    // 'error'
normalizeLogLevel(undefined);  // 'debug' (default)
normalizeLogLevel('invalid');  // 'debug' (with console warning)
```

### LogLevel Type

Type definition for valid log levels:

```typescript
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
```

### Usage Example

```typescript
import { BridgeServer, normalizeLogLevel } from 'ble-mcp-test';

const logLevel = normalizeLogLevel(process.env.BLE_MCP_LOG_LEVEL);
const server = new BridgeServer(logLevel);
await server.start();

// At debug level, you'll see [TX]/[RX] bytestream logs:
// [TX] A7 B3 C2 01 00 00 A0 00 B3 A7
// [RX] B3 A7 C2 01 00 00 00 00 A7 B3
```