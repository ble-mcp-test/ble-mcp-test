# ble-mcp-test Examples

## Table of Contents
- [Basic Connection](#basic-connection)
- [Playwright Integration](#playwright-integration)
- [Device Configuration](#device-configuration)
- [Error Handling](#error-handling)
- [Test Notification Injection](#test-notification-injection)
- [Mock Configuration](#mock-configuration)

## Basic Connection

### HTML Page Test
```html
<!DOCTYPE html>
<html>
<head>
    <script src="node_modules/ble-mcp-test/dist/web-ble-mock.bundle.js"></script>
</head>
<body>
    <button id="connect">Connect to Device</button>
    <div id="status"></div>
    
    <script>
        // Initialize the mock (v0.4.2+ required)
        WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
        
        document.getElementById('connect').onclick = async () => {
            try {
                const device = await navigator.bluetooth.requestDevice({
                    filters: [{ namePrefix: 'CS108' }],
                    optionalServices: ['9800']
                });
                
                const server = await device.gatt.connect();
                document.getElementById('status').textContent = 'Connected!';
                
                // Get service and characteristic
                const service = await server.getPrimaryService('9800');
                const writeChar = await service.getCharacteristic('9900');
                const notifyChar = await service.getCharacteristic('9901');
                
                // Enable notifications
                await notifyChar.startNotifications();
                notifyChar.addEventListener('characteristicvaluechanged', (event) => {
                    const value = new Uint8Array(event.target.value.buffer);
                    console.log('Received:', Array.from(value).map(b => b.toString(16).padStart(2, '0')).join(' '));
                });
                
                // Send a command
                await writeChar.writeValue(new Uint8Array([0xA7, 0xB3, 0x02]));
                
            } catch (error) {
                document.getElementById('status').textContent = 'Error: ' + error.message;
            }
        };
    </script>
</body>
</html>
```

## Playwright Integration

### Full Test Suite Example
```javascript
import { test, expect } from '@playwright/test';
import { injectWebBluetoothMock } from 'ble-mcp-test';

test.describe('BLE Device Tests', () => {
    test.beforeEach(async ({ page }) => {
        // Load the mock
        await page.addScriptTag({
            path: require.resolve('ble-mcp-test/dist/web-ble-mock.bundle.js')
        });
        
        // Configure and inject
        await page.evaluate(() => {
            const url = new URL('ws://localhost:8080');
            url.searchParams.set('device', 'CS108');
            url.searchParams.set('service', '9800');
            url.searchParams.set('write', '9900');
            url.searchParams.set('notify', '9901');
            
            WebBleMock.injectWebBluetoothMock(url.toString());
        });
    });
    
    test('connects to device and reads battery', async ({ page }) => {
        const batteryLevel = await page.evaluate(async () => {
            const device = await navigator.bluetooth.requestDevice({
                filters: [{ namePrefix: 'CS108' }]
            });
            
            const server = await device.gatt.connect();
            const service = await server.getPrimaryService('9800');
            const characteristic = await service.getCharacteristic('9900');
            
            // Send battery query command
            await characteristic.writeValue(new Uint8Array([0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00]));
            
            // Wait for response
            return new Promise((resolve) => {
                const notifyChar = await service.getCharacteristic('9901');
                await notifyChar.startNotifications();
                
                notifyChar.addEventListener('characteristicvaluechanged', (event) => {
                    const data = new Uint8Array(event.target.value.buffer);
                    // Extract battery voltage from response
                    const voltage = (data[10] << 8) | data[11];
                    resolve(voltage);
                });
            });
        });
        
        expect(batteryLevel).toBeGreaterThan(3600); // > 3.6V
        expect(batteryLevel).toBeLessThan(4200);    // < 4.2V
    });
});
```

## Device Configuration

### Using Query Parameters
```javascript
// Configure device-specific parameters via URL
const url = new URL('ws://localhost:8080');
url.searchParams.set('device', 'MyDevice');    // Device name prefix
url.searchParams.set('service', '180f');       // Service UUID
url.searchParams.set('write', '2a19');         // Write characteristic
url.searchParams.set('notify', '2a20');        // Notify characteristic

injectWebBluetoothMock(url.toString());
```

### Multiple Device Types
```javascript
// Function to configure mock for different device types
function configureMockForDevice(deviceType) {
    const configs = {
        heartRate: {
            device: 'HR-Monitor',
            service: '180d',
            write: '2a39',
            notify: '2a37'
        },
        thermometer: {
            device: 'TempSensor',
            service: '1809',
            write: '2a1c',
            notify: '2a1c'
        },
        custom: {
            device: 'CS108',
            service: '9800',
            write: '9900',
            notify: '9901'
        }
    };
    
    const config = configs[deviceType];
    const url = new URL('ws://localhost:8080');
    Object.entries(config).forEach(([key, value]) => {
        url.searchParams.set(key, value);
    });
    
    injectWebBluetoothMock(url.toString());
}
```

## Error Handling

### Handling Bridge Connection Errors
```javascript
test('handles bridge connection failure gracefully', async ({ page }) => {
    await page.evaluate(() => {
        // Try to connect to non-existent bridge
        WebBleMock.injectWebBluetoothMock('ws://localhost:9999');
    });
    
    const error = await page.evaluate(async () => {
        try {
            await navigator.bluetooth.requestDevice({
                filters: [{ namePrefix: 'Device' }]
            });
            return null;
        } catch (err) {
            return err.message;
        }
    });
    
    expect(error).toContain('Connection failed');
});
```

### Retry Logic (v0.4.1+)
```javascript
// The mock automatically retries when bridge is busy
// You'll see console logs like:
// [Mock] Bridge busy (Bridge is disconnecting), retry 1/10 in 1000ms...
// [Mock] Bridge busy (Bridge is disconnecting), retry 2/10 in 1500ms...
// [Mock] Connected successfully after 3 attempts

// Configure retry behavior via environment variables:
process.env.BLE_MCP_MOCK_MAX_RETRIES = '5';     // Max 5 retries
process.env.BLE_MCP_MOCK_RETRY_DELAY = '2000';  // Start with 2s delay
process.env.BLE_MCP_MOCK_BACKOFF = '2.0';       // Double delay each time
```

## Test Notification Injection

### Simulating Device Events (v0.4.1+)
```javascript
test('handles button press events', async ({ page }) => {
    const events = await page.evaluate(async () => {
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'CS108' }]
        });
        
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService('9800');
        const notifyChar = await service.getCharacteristic('9901');
        
        // Set up event listener
        const events = [];
        await notifyChar.startNotifications();
        notifyChar.addEventListener('characteristicvaluechanged', (event) => {
            const data = new Uint8Array(event.target.value.buffer);
            events.push({
                type: data[2] === 0x01 ? 'button' : 'other',
                pressed: data[3] === 0xFF
            });
        });
        
        // Simulate button press
        notifyChar.simulateNotification(new Uint8Array([0xA7, 0xB3, 0x01, 0xFF]));
        
        // Simulate button release after 100ms
        await new Promise(resolve => setTimeout(resolve, 100));
        notifyChar.simulateNotification(new Uint8Array([0xA7, 0xB3, 0x01, 0x00]));
        
        return events;
    });
    
    expect(events).toEqual([
        { type: 'button', pressed: true },
        { type: 'button', pressed: false }
    ]);
});
```

### Testing Error Conditions
```javascript
test('handles malformed packets', async ({ page }) => {
    const handled = await page.evaluate(async () => {
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'Device' }]
        });
        
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService('9800');
        const notifyChar = await service.getCharacteristic('9901');
        
        let errorHandled = false;
        await notifyChar.startNotifications();
        notifyChar.addEventListener('characteristicvaluechanged', (event) => {
            try {
                const data = new Uint8Array(event.target.value.buffer);
                if (data.length < 4) {
                    throw new Error('Packet too short');
                }
            } catch (error) {
                errorHandled = true;
            }
        });
        
        // Inject malformed packet
        notifyChar.simulateNotification(new Uint8Array([0xA7])); // Too short
        
        return errorHandled;
    });
    
    expect(handled).toBe(true);
});
```

## Mock Configuration

### Environment Variables (v0.4.1+)
```bash
# Configure mock retry behavior
export BLE_MCP_MOCK_RETRY_DELAY=2000      # Start with 2 second delay
export BLE_MCP_MOCK_MAX_RETRIES=5         # Try up to 5 times
export BLE_MCP_MOCK_BACKOFF=2.0           # Double delay each retry
export BLE_MCP_MOCK_LOG_RETRIES=false     # Disable retry logging
export BLE_MCP_MOCK_CLEANUP_DELAY=1000    # Wait 1s after disconnect

# Run your tests
npm test
```

### Programmatic Configuration
```javascript
// In your test setup
process.env.BLE_MCP_MOCK_RETRY_DELAY = '500';
process.env.BLE_MCP_MOCK_MAX_RETRIES = '20';
process.env.BLE_MCP_MOCK_LOG_RETRIES = 'true';

// These will be used by any subsequent mock instances
```

## Advanced Patterns

### Connection Pool Testing
```javascript
test('handles rapid connect/disconnect cycles', async ({ page }) => {
    const results = await page.evaluate(async () => {
        const results = [];
        
        for (let i = 0; i < 5; i++) {
            try {
                const device = await navigator.bluetooth.requestDevice({
                    filters: [{ namePrefix: 'Device' }]
                });
                
                const server = await device.gatt.connect();
                results.push({ attempt: i, connected: true });
                
                // Quick operation
                const service = await server.getPrimaryService('9800');
                
                // Disconnect
                await server.disconnect();
                
                // Wait for bridge recovery
                await new Promise(resolve => setTimeout(resolve, 6000));
                
            } catch (error) {
                results.push({ attempt: i, connected: false, error: error.message });
            }
        }
        
        return results;
    });
    
    // All attempts should succeed with proper recovery timing
    const successful = results.filter(r => r.connected).length;
    expect(successful).toBe(5);
});
```

### Custom Transport Configuration
```javascript
// Use with remote bridge server
injectWebBluetoothMock('wss://ble-bridge.example.com');

// Use with authentication
const url = new URL('ws://localhost:8080');
url.username = 'testuser';
url.password = 'testpass';
injectWebBluetoothMock(url.toString());
```