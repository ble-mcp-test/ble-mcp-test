# Best Practices for ble-mcp-test

## Environment Variable Configuration

Always use environment variables for configuration. Never hardcode connection parameters.

### Complete Configuration Example

Create a `.env.local` file:
```bash
# WebSocket Server Configuration
BLE_MCP_WS_HOST=localhost
BLE_MCP_WS_PORT=8080

# BLE Device Configuration
BLE_MCP_DEVICE_IDENTIFIER=6c79b82603a7
BLE_MCP_SERVICE_UUID=9800
BLE_MCP_WRITE_UUID=9900
BLE_MCP_NOTIFY_UUID=9901

# Optional: Recovery timing
BLE_MCP_RECOVERY_DELAY=5000

# Optional: Mock configuration
BLE_MCP_MOCK_RETRY_DELAY=1200
BLE_MCP_MOCK_MAX_RETRIES=20
BLE_MCP_MOCK_CLEANUP_DELAY=1100
```

### In Your Tests

```javascript
import { injectWebBluetoothMock } from 'ble-mcp-test';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.local' });

// Helper to build WebSocket URL from environment
function getWebSocketUrl() {
  const host = process.env.BLE_MCP_WS_HOST || 'localhost';
  const port = process.env.BLE_MCP_WS_PORT || '8080';
  const url = new URL(`ws://${host}:${port}`);
  
  // Add BLE configuration
  url.searchParams.set('device', process.env.BLE_MCP_DEVICE_IDENTIFIER || 'CS108');
  url.searchParams.set('service', process.env.BLE_MCP_SERVICE_UUID || '9800');
  url.searchParams.set('write', process.env.BLE_MCP_WRITE_UUID || '9900');
  url.searchParams.set('notify', process.env.BLE_MCP_NOTIFY_UUID || '9901');
  
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

// Reusable configuration helper
function getBleEnvironment() {
  return {
    wsHost: process.env.BLE_MCP_WS_HOST || 'localhost',
    wsPort: process.env.BLE_MCP_WS_PORT || '8080',
    device: process.env.BLE_MCP_DEVICE_IDENTIFIER || 'CS108',
    service: process.env.BLE_MCP_SERVICE_UUID || '9800',
    write: process.env.BLE_MCP_WRITE_UUID || '9900',
    notify: process.env.BLE_MCP_NOTIFY_UUID || '9901'
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

The bridge has a 1s recovery period after clean disconnects. The mock automatically waits 1.1s before attempting reconnection.

If you need rapid reconnections:
```javascript
// Set shorter recovery for testing
process.env.BLE_MCP_RECOVERY_DELAY = '500';
process.env.BLE_MCP_MOCK_CLEANUP_DELAY = '600';
```

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
```javascript
// Use MCP tools to check bridge state
const response = await fetch('http://localhost:8081/health');
const health = await response.json();
console.log('Bridge state:', health.state);
```

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
  const characteristic = await service.getCharacteristic('9901');
  
  // Simulate device notification
  characteristic.simulateNotification(new Uint8Array([0xA7, 0xB3, 0x01, 0xFF]));
  
  // Your test assertions here
});
```