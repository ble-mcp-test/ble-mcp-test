# web-ble-bridge

A minimal WebSocket-to-BLE bridge that enables Web Bluetooth API testing in browsers without built-in BLE support.

## What is this?

This package solves a common problem: **testing Web Bluetooth code in environments that don't support it**. It provides:

1. **A WebSocket bridge server** that runs on a machine with BLE hardware (like a Raspberry Pi or Mac)
2. **A Web Bluetooth API mock** that you use in your browser tests to communicate with real BLE devices through the bridge

This lets you write and test Web Bluetooth applications on any machine, even if it doesn't have Bluetooth hardware or browser support.

## Installation

### For testing (recommended)
```bash
# npm
npm install --save-dev @trakrf/web-ble-bridge

# pnpm
pnpm add -D @trakrf/web-ble-bridge

# yarn
yarn add --dev @trakrf/web-ble-bridge
```

### For production use
```bash
# npm
npm install @trakrf/web-ble-bridge

# pnpm  
pnpm add @trakrf/web-ble-bridge

# yarn
yarn add @trakrf/web-ble-bridge
```

## Quick Start

### Step 1: Run the Bridge Server (on a machine with BLE)

```bash
# Using npx (no installation needed)
npx @trakrf/web-ble-bridge

# Or if installed globally
web-ble-bridge
```

The server will start on `ws://localhost:8080` by default.

### Step 2: Use in Your Browser Tests

```html
<!-- In your test HTML -->
<script src="node_modules/@trakrf/web-ble-bridge/dist/web-ble-mock.bundle.js"></script>
<script>
    // Initialize the mock with your bridge server URL
    WebBleMock.injectWebBluetoothMock('ws://localhost:8080');

    // Now use Web Bluetooth API as normal!
    async function connectToDevice() {
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'MyDevice' }],
            optionalServices: ['180f'] // Battery service
        });

        const server = await device.gatt.connect();
        const service = await server.getPrimaryService('180f');
        const characteristic = await service.getCharacteristic('2a19');
        const value = await characteristic.readValue();
        console.log('Battery level:', value.getUint8(0), '%');
    }
</script>
```

## Complete Examples

### Example 1: Playwright E2E Test

```javascript
import { test, expect } from '@playwright/test';

test('read battery level from BLE device', async ({ page }) => {
  // Load test page
  await page.goto('/test.html');

  // Inject the Web Bluetooth mock
  await page.addScriptTag({
    path: 'node_modules/@trakrf/web-ble-bridge/dist/web-ble-mock.bundle.js'
  });

  // Initialize mock with bridge server
  await page.evaluate(() => {
    WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
  });

  // Test Web Bluetooth code
  const batteryLevel = await page.evaluate(async () => {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'MyDevice' }]
    });
    const server = await device.gatt.connect();
    // ... rest of Web Bluetooth code
    return batteryLevel;
  });

  expect(batteryLevel).toBeGreaterThan(0);
});
```

### Example 2: Device-Agnostic Configuration

The bridge supports any BLE device. Specify your device's UUIDs via URL parameters:

```javascript
// Configure for a custom BLE device
const bridgeUrl = new URL('ws://localhost:8080');
bridgeUrl.searchParams.set('device', 'MyDevice');      // Device name prefix
bridgeUrl.searchParams.set('service', '180f');         // Service UUID
bridgeUrl.searchParams.set('write', '2a19');          // Write characteristic UUID
bridgeUrl.searchParams.set('notify', '2a20');         // Notify characteristic UUID

WebBleMock.injectWebBluetoothMock(bridgeUrl.toString());
```

### Example 3: Running Bridge on Remote Machine

```bash
# On Raspberry Pi with BLE hardware
WS_HOST=0.0.0.0 WS_PORT=8080 npx @trakrf/web-ble-bridge

# In your tests (from another machine)
WebBleMock.injectWebBluetoothMock('ws://raspberrypi.local:8080');
```

## Configuration

### Bridge Server Options

Environment variables:
- `WS_HOST` - WebSocket host (default: `0.0.0.0`)
- `WS_PORT` - WebSocket port (default: `8080`)

### Device Configuration

Pass device configuration via URL parameters:
- `device` - Device name prefix to search for
- `service` - BLE service UUID
- `write` - Write characteristic UUID
- `notify` - Notify characteristic UUID

Example:
```
ws://localhost:8080?device=CS108&service=9800&write=9900&notify=9901
```

## How It Works

1. **Bridge Server**: Runs on a machine with BLE hardware, creates WebSocket server
2. **Web Bluetooth Mock**: Replaces `navigator.bluetooth` in the browser
3. **Communication**: Mock sends Web Bluetooth API calls over WebSocket to bridge
4. **BLE Operations**: Bridge performs actual BLE operations using Noble.js
5. **Results**: Bridge sends results back to browser over WebSocket

**Important**: The bridge currently supports **one connection at a time**. Multiple WebSocket clients can connect, but only one can have an active BLE connection. This design prevents race conditions and ensures reliable operation.

## Architecture Diagram

The following sequence diagram shows the complete data flow from test to device:

```mermaid
sequenceDiagram
    participant Test as Playwright Test
    participant Browser as Browser (Mock)
    participant Bridge as Bridge Server
    participant BLE as BLE Device

    Note over Test,Browser: 1. Test Setup
    Test->>Browser: injectWebBluetoothMock('ws://localhost:8080')
    Browser->>Browser: Replace navigator.bluetooth

    Note over Test,BLE: 2. Device Connection
    Test->>Browser: navigator.bluetooth.requestDevice()
    Browser->>Bridge: WebSocket connect<br/>ws://localhost:8080?device=CS108&service=...
    Bridge->>BLE: Noble scan for device
    BLE-->>Bridge: Device found
    Bridge->>BLE: Connect via Noble
    BLE-->>Bridge: Connected
    Bridge-->>Browser: {"type": "connected", "device": "CS108-123"}
    Browser-->>Test: Return MockBluetoothDevice

    Note over Test,BLE: 3. Data Exchange
    Test->>Browser: characteristic.writeValue([0xA7, 0xB3, ...])
    Browser->>Bridge: {"type": "data", "data": [167, 179, ...]}
    Bridge->>BLE: Write via Noble
    
    BLE->>Bridge: Notification data
    Bridge->>Browser: {"type": "data", "data": [179, 167, ...]}
    Browser->>Test: characteristicvaluechanged event

    Note over Test,BLE: 4. Disconnection
    Test->>Browser: device.gatt.disconnect()
    Browser->>Bridge: WebSocket close
    Bridge->>BLE: Disconnect via Noble
    Bridge->>Bridge: Cleanup connection
```

## Protocol

The bridge uses a simple JSON protocol over WebSocket:

### Browser → Bridge
```json
{ "type": "data", "data": [0xA7, 0xB3, 0x02, ...] }
```

### Bridge → Browser
```json
{ "type": "connected", "device": "MyDevice-123456" }
{ "type": "data", "data": [0xB3, 0xA7, 0x04, ...] }
{ "type": "error", "error": "No device found" }
{ "type": "disconnected" }
```

## Requirements

- **Bridge Server**: Node.js 24.x (required for Noble.js BLE support)
- **Browser**: Any modern browser (Chrome, Firefox, Safari, Edge)
- **BLE Hardware**: Only needed on the machine running the bridge server

## Troubleshooting

### "No device found" error
- Ensure BLE is enabled on the bridge server machine
- Check that your device is powered on and in range
- Verify the device name prefix matches

### "Connection timeout" error
- Check firewall settings if using remote bridge
- Ensure WebSocket port is accessible
- Try using IP address instead of hostname

### Bridge server crashes
- Ensure Node.js 24.x is installed (not 22.x or 26.x)
- Check for other processes using the same port
- Run with debug logging: `DEBUG=* npx @trakrf/web-ble-bridge`

## Documentation

- [API Documentation](docs/API.md) - Detailed API reference
- [Migration Guide](docs/MIGRATION.md) - Migrating from native Web Bluetooth

## Roadmap

### v0.2.0 - Multi-Device Support
- Support multiple simultaneous BLE connections
- Route WebSocket clients to specific devices
- Connection pooling and management

### v0.3.0 - CLI Tools
- `web-ble-bridge scan` - Scan for nearby BLE devices
- `web-ble-bridge test <device>` - Test connection to a device
- `web-ble-bridge reset` - Reset BLE adapter
- `web-ble-bridge monitor` - Live connection monitoring

### Future Considerations
- Reconnection support with configurable retry
- WebSocket authentication/authorization
- Metrics and monitoring endpoints
- Docker container for easy deployment

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

If you're interested in working on any of the roadmap items, please open an issue to discuss first.

## License

MIT