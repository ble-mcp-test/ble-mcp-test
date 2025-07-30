# Migration Guide

## Migrating from v0.3.x to v0.4.0

> ⚠️ **v0.4.0 is a major breaking change release!**  
> This version includes significant architectural improvements and a complete standardization of environment variables.  
> **There is NO backward compatibility with v0.3.x.**

### ⚠️ BREAKING: Environment Variable Changes

All environment variables have been standardized with the `BLE_MCP_` prefix. **Old variable names are no longer supported.**

| Old Variable | New Variable | Description |
|--------------|--------------|-------------|
| `WS_HOST` | `BLE_MCP_WS_HOST` | WebSocket server host |
| `WS_PORT` | `BLE_MCP_WS_PORT` | WebSocket server port |
| `LOG_LEVEL` | `BLE_MCP_LOG_LEVEL` | Logging level |
| `LOG_BUFFER_SIZE` | `BLE_MCP_LOG_BUFFER_SIZE` | Log buffer size |
| `CLIENT_IDLE_TIMEOUT` | `BLE_MCP_CLIENT_IDLE_TIMEOUT` | Client idle timeout (ms) |
| `MCP_TOKEN` | `BLE_MCP_HTTP_TOKEN` | MCP HTTP authentication token |
| `MCP_PORT` | `BLE_MCP_HTTP_PORT` | MCP HTTP server port |
| `DISABLE_STDIO` | `BLE_MCP_STDIO_DISABLED` | Disable stdio transport (set to "true") |
| `BLE_CONNECTION_STABILITY` | `BLE_MCP_CONNECTION_STABILITY` | BLE connection stability delay |
| `BLE_PRE_DISCOVERY_DELAY` | `BLE_MCP_PRE_DISCOVERY_DELAY` | Pre-discovery delay |
| `BLE_NOBLE_RESET_DELAY` | `BLE_MCP_NOBLE_RESET_DELAY` | Noble reset delay |
| `BLE_SCAN_TIMEOUT` | `BLE_MCP_SCAN_TIMEOUT` | BLE scan timeout |
| `BLE_CONNECTION_TIMEOUT` | `BLE_MCP_CONNECTION_TIMEOUT` | BLE connection timeout |
| `BLE_DISCONNECT_COOLDOWN` | `BLE_MCP_DISCONNECT_COOLDOWN` | Disconnect cooldown |

**Test Configuration Variables:**
| Old Variable | New Variable | Description |
|--------------|--------------|-------------|
| `TEST_DEVICE` | `BLE_MCP_TEST_DEVICE` | Test device name |
| `BLE_DEVICE_PREFIX` | `BLE_MCP_DEVICE_NAME` | BLE device name prefix |
| `BLE_SERVICE_UUID` | `BLE_MCP_SERVICE_UUID` | BLE service UUID |
| `BLE_WRITE_UUID` | `BLE_MCP_WRITE_UUID` | Write characteristic UUID |
| `BLE_NOTIFY_UUID` | `BLE_MCP_NOTIFY_UUID` | Notify characteristic UUID |
| `WS_URL` | `BLE_MCP_TEST_WS_URL` | Test WebSocket URL |
| N/A | `BLE_MCP_DEVICE_MAC` | Device MAC address (Linux) |

**You MUST update your .env.local file:**

```bash
# v0.4.0 - REQUIRED format
BLE_MCP_WS_HOST=0.0.0.0
BLE_MCP_WS_PORT=8080
BLE_MCP_LOG_LEVEL=info
BLE_MCP_CLIENT_IDLE_TIMEOUT=45000
BLE_MCP_DEVICE_NAME=CS108
BLE_MCP_SERVICE_UUID=9800
BLE_MCP_WRITE_UUID=9900
BLE_MCP_NOTIFY_UUID=9901
```

⚠️ **The old environment variable names (WS_PORT, LOG_LEVEL, etc.) will no longer work!**

### Breaking Changes

#### 1. Connection Token in `connected` Message
The `connected` message now includes a mandatory `token` field:

**Before (v0.3.x):**
```javascript
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'connected') {
    console.log('Connected to:', msg.device);
  }
});
```

**After (v0.4.0):**
```javascript
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'connected') {
    console.log('Connected to:', msg.device);
    console.log('Connection token:', msg.token); // NEW: Store this for force_cleanup
  }
});
```

#### 2. Client Idle Timeout
Clients are now automatically disconnected after 45 seconds of inactivity:

```javascript
// Handle eviction warnings
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'eviction_warning') {
    console.warn(`Idle timeout warning! ${msg.grace_period_ms}ms until disconnect`);
    // Send keepalive to prevent disconnection
    ws.send(JSON.stringify({ type: 'keepalive' }));
  }
});

// Or send periodic keepalives
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'keepalive' }));
  }
}, 30000); // Every 30 seconds
```

#### 3. Force Cleanup Requires Token
The `force_cleanup` command now requires the connection token:

**Before (v0.3.x):**
```javascript
ws.send(JSON.stringify({ type: 'force_cleanup' }));
```

**After (v0.4.0):**
```javascript
let connectionToken;

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'connected') {
    connectionToken = msg.token; // Store token
  }
});

// Later, when force cleanup is needed:
ws.send(JSON.stringify({ 
  type: 'force_cleanup',
  token: connectionToken
}));
```

#### 4. Enhanced Health Check
The health endpoint now includes state machine information:

```javascript
// Connect to health endpoint
const healthWs = new WebSocket('ws://localhost:8080/?command=health');

healthWs.on('message', (data) => {
  const health = JSON.parse(data);
  console.log('Server state:', health.state); // NEW: IDLE, ACTIVE, or EVICTING
  console.log('Connection info:', health.connectionInfo); // NEW: Active connection details
});
```

### New Features

#### Keepalive Messages
Prevent idle timeout by sending keepalive messages:

```javascript
// Send keepalive
ws.send(JSON.stringify({ type: 'keepalive' }));

// Receive acknowledgment
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'keepalive_ack') {
    console.log('Keepalive acknowledged at:', msg.timestamp);
  }
});
```

#### Configurable Idle Timeout
Set custom idle timeout for testing or specific use cases:

```bash
# Set 60-second timeout
BLE_MCP_CLIENT_IDLE_TIMEOUT=60000 ble-mcp-test

# For tests, use shorter timeout
BLE_MCP_CLIENT_IDLE_TIMEOUT=5000 pnpm test
```

### WebSocketTransport Updates
If you're using the WebSocketTransport class directly:

```javascript
import { WebSocketTransport } from 'ble-mcp-test';

const transport = new WebSocketTransport('ws://localhost:8080');

// The transport now handles tokens automatically
await transport.connect({ device: 'MyDevice' });

// Force cleanup uses stored token
await transport.forceCleanup(); // Token included automatically
```

### Testing Considerations

For integration tests, use shorter idle timeouts:

```javascript
// In your test setup
process.env.BLE_MCP_CLIENT_IDLE_TIMEOUT = '5000'; // 5 seconds for tests

// In your test
it('should handle idle timeout', async () => {
  // Connect
  const ws = new WebSocket(url);
  
  // Wait for eviction warning
  await new Promise(resolve => setTimeout(resolve, 5500));
  
  // Verify eviction warning received
  expect(messages).toContainEqual(
    expect.objectContaining({ type: 'eviction_warning' })
  );
});
```

## Migrating from Native Web Bluetooth to ble-mcp-test

If you have existing Web Bluetooth code that you want to test in environments without BLE support, the migration is straightforward.

### Before (Native Web Bluetooth)

```javascript
// Your existing Web Bluetooth code
async function connectToDevice() {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'MyDevice' }],
    optionalServices: ['180f']
  });
  
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService('180f');
  const battery = await service.getCharacteristic('2a19');
  const value = await battery.readValue();
  
  console.log('Battery:', value.getUint8(0), '%');
}
```

### After (Using ble-mcp-test)

```javascript
// Add this before your Web Bluetooth code
import { injectWebBluetoothMock } from 'ble-mcp-test';

// Configure the bridge (only needed once)
const bridgeUrl = new URL('ws://localhost:8080');
bridgeUrl.searchParams.set('device', 'MyDevice');
bridgeUrl.searchParams.set('service', '180f');
bridgeUrl.searchParams.set('write', '2a19');  // If you write to this characteristic
bridgeUrl.searchParams.set('notify', '2a19'); // If you receive notifications

injectWebBluetoothMock(bridgeUrl.toString());

// Your existing code works unchanged!
async function connectToDevice() {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'MyDevice' }],
    optionalServices: ['180f']
  });
  
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService('180f');
  const battery = await service.getCharacteristic('2a19');
  const value = await battery.readValue();
  
  console.log('Battery:', value.getUint8(0), '%');
}
```

## Key Differences

### 1. No User Interaction Required
Native Web Bluetooth requires user interaction (click/tap) to show the device chooser. The mock bypasses this, making it perfect for automated testing.

### 2. Device Configuration
You specify which device to connect to via URL parameters instead of the user choosing from a dialog.

### 3. Cross-Platform Testing
Your tests can run on any platform, even those without Bluetooth hardware or browser support.

## Testing Strategies

### Development Testing

During development, run the bridge locally:

```javascript
// In your test setup
if (process.env.NODE_ENV === 'test') {
  injectWebBluetoothMock('ws://localhost:8080');
}
```

### CI/CD Testing

For CI/CD, run the bridge on a dedicated machine:

```javascript
// In your test setup
if (process.env.CI) {
  const bridgeUrl = process.env.BLE_BRIDGE_URL || 'ws://ble-test-server:8080';
  injectWebBluetoothMock(bridgeUrl);
}
```

### Feature Detection

You can check if the mock is active:

```javascript
// After injecting the mock
if (navigator.bluetooth.constructor.name === 'MockBluetooth') {
  console.log('Using ble-mcp-test mock');
} else {
  console.log('Using native Web Bluetooth');
}
```

## Limitations

The mock implements the most commonly used Web Bluetooth API methods. Currently not supported:

- `getDevices()` - Listing paired devices
- `getAvailability()` - Checking if Bluetooth is available
- `addEventListener()` on `navigator.bluetooth`
- GATT server events
- Multiple simultaneous device connections

If you need these features, please [open an issue](https://github.com/ble-mcp-test/ble-mcp-test/issues).

## Best Practices

1. **Environment-specific configuration**: Only inject the mock in test environments
2. **Graceful fallback**: Check if the bridge is available before injecting
3. **Error handling**: The mock provides the same errors as native Web Bluetooth
4. **Resource cleanup**: Always disconnect devices after tests

## Example: Playwright Test

```javascript
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Only inject mock if bridge is available
  const bridgeAvailable = await fetch('http://localhost:8080')
    .then(() => true)
    .catch(() => false);
    
  if (bridgeAvailable) {
    await page.addScriptTag({ 
      path: 'node_modules/ble-mcp-test/dist/web-ble-mock.bundle.js' 
    });
    
    await page.evaluate(() => {
      WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
    });
  }
});
```