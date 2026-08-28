# Best Practices for ble-mcp-test

## Environment Variable Configuration

Always use environment variables for configuration. Never hardcode connection parameters.

### Complete Configuration Example

Create a `.env.local` file:
```bash
# WebSocket Server Configuration
BLE_MCP_WS_HOST=localhost
BLE_MCP_WS_PORT=25153

# BLE Device Configuration
BLE_MCP_DEVICE_IDENTIFIER=6c79b8xxxxxx
BLE_MCP_SERVICE_UUID=00009800-0000-1000-8000-00805f9b34fb
BLE_MCP_WRITE_UUID=00009900-0000-1000-8000-00805f9b34fb
BLE_MCP_NOTIFY_UUID=00009901-0000-1000-8000-00805f9b34fb

# Optional: Recovery timing
BLE_MCP_RECOVERY_DELAY=1000

# Optional: Mock configuration
BLE_MCP_MOCK_RETRY_DELAY=1200
BLE_MCP_MOCK_MAX_RETRIES=20
BLE_MCP_MOCK_CLEANUP_DELAY=250
```

> UUIDs must be the full lowercase 128-bit form. Since 0.8.0 the mock
> canonicalises the way real Chromium does and **rejects short forms like
> `9800` with a TypeError** — this section used to show them, and following it
> failed on the first `getCharacteristic`.

### In Your Tests

```javascript
import { injectWebBluetoothMock } from 'ble-mcp-test/browser';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.local' });

// Helper to build WebSocket URL from environment
function getWebSocketUrl() {
  const host = process.env.BLE_MCP_WS_HOST || 'localhost';
  const port = process.env.BLE_MCP_WS_PORT || '25153';  // matches the bridge default
  const url = new URL(`ws://${host}:${port}`);
  
  // Add BLE configuration
  url.searchParams.set('device', process.env.BLE_MCP_DEVICE_IDENTIFIER || 'CS108');
  url.searchParams.set('service', process.env.BLE_MCP_SERVICE_UUID || '00009800-0000-1000-8000-00805f9b34fb');
  url.searchParams.set('write', process.env.BLE_MCP_WRITE_UUID || '00009900-0000-1000-8000-00805f9b34fb');
  url.searchParams.set('notify', process.env.BLE_MCP_NOTIFY_UUID || '00009901-0000-1000-8000-00805f9b34fb');
  
  return url.toString();
}

// Use in your test
test('connect to device', async () => {
  injectWebBluetoothMock(getWebSocketUrl());
  
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: process.env.BLE_MCP_DEVICE_IDENTIFIER?.substring(0, 6) || 'CS108' }]
  });
  
  // ... rest of test
});
```

### In Playwright Tests

```javascript
import { test } from '@playwright/test';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

// Mirrors the bridge's own default so the two cannot disagree. The rule is not
// "no defaults" -- it is that a default must never be a port a co-resident
// service owns. 8080 was the consumer's own backend; 25153 was picked not to be.
function bridgePort(): string {
  return process.env.BLE_MCP_WS_PORT || '25153';
}

// Reusable configuration helper
function getBleEnvironment() {
  return {
    wsHost: process.env.BLE_MCP_WS_HOST || 'localhost',
    wsPort: bridgePort(),
    device: process.env.BLE_MCP_DEVICE_IDENTIFIER || 'CS108',
    service: process.env.BLE_MCP_SERVICE_UUID || '00009800-0000-1000-8000-00805f9b34fb',
    write: process.env.BLE_MCP_WRITE_UUID || '00009900-0000-1000-8000-00805f9b34fb',
    notify: process.env.BLE_MCP_NOTIFY_UUID || '00009901-0000-1000-8000-00805f9b34fb'
  };
}

test('BLE device test', async ({ page }) => {
  await page.goto('about:blank');
  
  // Load mock bundle
  await page.addScriptTag({ 
    path: 'node_modules/ble-mcp-test/dist/web-ble-mock.bundle.js' 
  });
  
  // Pass environment to browser context
  await page.evaluate((config) => {
    const url = new URL(`ws://${config.wsHost}:${config.wsPort}`);
    url.searchParams.set('device', config.device);
    url.searchParams.set('service', config.service);
    url.searchParams.set('write', config.write);
    url.searchParams.set('notify', config.notify);
    
    window.WebBleMock.injectWebBluetoothMock(url.toString());
  }, getBleEnvironment());
  
  // Your test code here
});
```

## Connection Lifecycle Best Practices

### 1. Reuse Connections When Possible

```javascript
describe('Device Tests', () => {
  let device;
  
  beforeAll(async () => {
    injectWebBluetoothMock(getWebSocketUrl());
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'CS108' }]
    });
    await device.gatt.connect();
  });
  
  afterAll(async () => {
    await device?.gatt?.disconnect();
  });
  
  test('test 1', async () => {
    // Use existing connection
  });
  
  test('test 2', async () => {
    // Use existing connection
  });
});
```

### 2. Handle Recovery Timing

The mock waits `postDisconnectDelay` after a disconnect before reconnecting.
It is **250ms**, and that number is measured rather than guessed: 997 real
disconnect cycles against the Python bridge put socket-close-to-device-released
at median 16ms, p99 21ms, max 30ms, so 250ms keeps roughly 8x margin over the
worst case observed.

It was 1100ms, inherited from the deleted TypeScript bridge with the comment
"1.1s to ensure server is ready". If you find advice recommending 600-1100ms
here, it predates the measurement.

Shortening it below the measured worst case buys nothing and risks racing the
release — the bridge holds one writer slot, and a connect issued before the
previous release is processed is refused `Device is busy`.

### 3. Error Handling

Always handle connection failures gracefully:
```javascript
try {
  await device.gatt.connect();
} catch (error) {
  if (error.message.includes('Bridge is disconnecting')) {
    // Bridge is in recovery, will retry automatically
    console.log('Mock will retry connection...');
  } else {
    throw error; // Unexpected error
  }
}
```

## Debugging Tips

### Enable Retry Logging
```bash
export BLE_MCP_MOCK_LOG_RETRIES=true
```

### Check Device Availability
```bash
pnpm run check:device
```

### Monitor Bridge State

The bridge serves **no HTTP health endpoint**. It speaks WebSocket on
`BLE_MCP_WS_PORT` (25153 by default) and nothing else over TCP; state is read
through the MCP server, which attaches over a unix socket rather than a port.

```bash
# Is the bridge listening at all?
ss -ltn | grep 25153
```

For connection state, held device and traffic, use the MCP tools —
`get_connection_state`, `read_stream`, `status`. See
[MCP-SERVER.md](./MCP-SERVER.md).

> This section previously suggested `fetch('http://localhost:8081/health')`. [tra-1186-historical]
> That endpoint died with the TypeScript server (TRA-1161) and the Python bridge
> has never served it, so the snippet returned a connection error against a
> perfectly healthy bridge — reading as an outage rather than as a dead URL.

## Common Pitfalls to Avoid

1. **Don't hardcode URLs or device IDs** - Use environment variables
2. **Don't create new connections for each test** - Reuse when possible
3. **Don't ignore recovery timing** - The 1s delay is necessary for BLE stability
4. **Don't skip error handling** - Connection failures are normal during recovery
5. **Don't mix device types** - Stick to one device configuration per test suite

## Testing Without Real Hardware

For CI or development without BLE hardware:
```javascript
// Mock the device responses
test('simulated device test', async ({ page }) => {
  // ... setup mock as usual
  
  // Get characteristic
  const characteristic = await service.getCharacteristic('00009901-0000-1000-8000-00805f9b34fb');
  
  // Use testing API for device notification simulation  
  const { simulateNotification } = navigator.bluetooth.testing;
  
  await simulateNotification({
    characteristic: characteristic,
    data: new Uint8Array([0xA7, 0xB3, 0x01, 0xFF])
  });
  
  // Your test assertions here
});
```