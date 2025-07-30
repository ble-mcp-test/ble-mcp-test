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

### injectWebBluetoothMock(serverUrl: string)

Replaces the browser's `navigator.bluetooth` with a mock that communicates with the bridge server.

```javascript
import { injectWebBluetoothMock } from 'ble-mcp-test';

// Basic usage
injectWebBluetoothMock('ws://localhost:8080');

// With device configuration
const url = new URL('ws://localhost:8080');
url.searchParams.set('device', 'MyDevice');
url.searchParams.set('service', '180f');
url.searchParams.set('write', '2a19');
url.searchParams.set('notify', '2a20');
injectWebBluetoothMock(url.toString());
```

### Using the Browser Bundle

If you're not using a module bundler, include the pre-built bundle:

```html
<script src="path/to/web-ble-mock.bundle.js"></script>
<script>
  // Global WebBleMock object is available
  WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
</script>
```

## MCP HTTP Endpoints

When running with HTTP transport (`pnpm start:http` or `--mcp-http`), the following endpoints are available:

### GET /mcp/info

Public endpoint that returns server metadata and available tools. No authentication required.

**Response:**
```json
{
  "name": "ble-mcp-test",
  "version": "0.3.1",
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
  "version": "0.3.1",
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
  "device": "CS108Reader2603A7",
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

## Breaking Changes in v0.4.0

### Connection Token
All successful connections now receive a unique authentication token:
- The `connected` message includes a `token` field
- This token is required for `force_cleanup` operations
- Token format: UUID v4 (e.g., `550e8400-e29b-41d4-a716-446655440000`)

### Client Idle Timeout
Clients are automatically disconnected after a period of inactivity:
- Default timeout: 45 seconds (configurable via `BLE_MCP_CLIENT_IDLE_TIMEOUT` environment variable)
- Clients receive an `eviction_warning` message 5 seconds before disconnection
- Send `keepalive` messages to prevent idle timeout
- All activity messages (`data`, `disconnect`, `cleanup`, etc.) reset the idle timer

### Enhanced Health Endpoint
The health check WebSocket endpoint now includes:
- `state`: Server state machine state (IDLE, ACTIVE, EVICTING)
- `transportState`: BLE transport state
- `connectionInfo`: Active connection details including token and timestamps

### State Machine
The server now uses a formal state machine for connection lifecycle:
- **IDLE**: No active connections, ready to accept new connections
- **ACTIVE**: Connection established and operational
- **EVICTING**: Connection being terminated due to idle timeout

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
  await page.evaluate(() => {
    const url = new URL('ws://localhost:8080');
    url.searchParams.set('device', 'CS108');
    url.searchParams.set('service', '9800');
    url.searchParams.set('write', '9900');
    url.searchParams.set('notify', '9901');
    
    WebBleMock.injectWebBluetoothMock(url.toString());
  });
  
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