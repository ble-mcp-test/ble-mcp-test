# API Documentation

## Server API

### BridgeServer

The main WebSocket bridge server class.

```javascript
import { BridgeServer } from '@trakrf/web-ble-bridge';

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
import { injectWebBluetoothMock } from '@trakrf/web-ble-bridge';

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

#### Server → Client Messages

**Device connected:**
```json
{
  "type": "connected",
  "device": "CS108Reader2603A7"
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
    path: 'node_modules/@trakrf/web-ble-bridge/dist/web-ble-mock.bundle.js' 
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