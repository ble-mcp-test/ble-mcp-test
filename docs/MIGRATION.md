# Migration Guide

## Migrating from Native Web Bluetooth to web-ble-bridge

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

### After (Using web-ble-bridge)

```javascript
// Add this before your Web Bluetooth code
import { injectWebBluetoothMock } from '@trakrf/web-ble-bridge';

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
  console.log('Using web-ble-bridge mock');
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

If you need these features, please [open an issue](https://github.com/trakrf/web-ble-bridge/issues).

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
      path: 'node_modules/@trakrf/web-ble-bridge/dist/web-ble-mock.bundle.js' 
    });
    
    await page.evaluate(() => {
      WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
    });
  }
});
```