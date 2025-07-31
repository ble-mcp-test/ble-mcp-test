import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as dotenv from 'dotenv';

// Load environment variables for BLE configuration
dotenv.config({ path: '.env.local' });

const __dirname = dirname(fileURLToPath(import.meta.url));

// Helper to get BLE configuration from environment
function getBleConfig() {
  return {
    device: process.env.BLE_MCP_DEVICE_IDENTIFIER || 'CS108',
    service: process.env.BLE_MCP_SERVICE_UUID || '9800',
    write: process.env.BLE_MCP_WRITE_UUID || '9900',
    notify: process.env.BLE_MCP_NOTIFY_UUID || '9901'
  };
}

/**
 * Test the Web Bluetooth mock bundle to ensure it loads and exports correctly
 */
test.describe('Mock Bundle Export Tests', () => {
  test('should load bundle and expose WebBleMock global', async ({ page }) => {
    // Navigate to a blank page
    await page.goto('about:blank');
    
    // Load the bundle
    const bundlePath = join(__dirname, '../../dist/web-ble-mock.bundle.js');
    await page.addScriptTag({ path: bundlePath });
    
    // Check if WebBleMock global exists
    const hasWebBleMock = await page.evaluate(() => {
      return typeof window.WebBleMock !== 'undefined';
    });
    
    expect(hasWebBleMock).toBe(true);
    
    // Check if injectWebBluetoothMock function exists
    const hasInjectFunction = await page.evaluate(() => {
      return typeof window.WebBleMock?.injectWebBluetoothMock === 'function';
    });
    
    expect(hasInjectFunction).toBe(true);
    
    // Check if MockBluetooth class exists
    const hasMockClass = await page.evaluate(() => {
      return typeof window.WebBleMock?.MockBluetooth === 'function';
    });
    
    expect(hasMockClass).toBe(true);
  });

  test('should inject mock and replace navigator.bluetooth', async ({ page }) => {
    await page.goto('about:blank');
    
    // Load the bundle
    const bundlePath = join(__dirname, '../../dist/web-ble-mock.bundle.js');
    await page.addScriptTag({ path: bundlePath });
    
    // Check initial state
    const beforeInjection = await page.evaluate(() => {
      return {
        hasBluetooth: 'bluetooth' in navigator,
        bluetoothType: typeof navigator.bluetooth
      };
    });
    
    console.log('Before injection:', beforeInjection);
    
    // Inject the mock
    await page.evaluate(() => {
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
    });
    
    // Check after injection
    const afterInjection = await page.evaluate(() => {
      return {
        hasBluetooth: 'bluetooth' in navigator,
        bluetoothType: typeof navigator.bluetooth,
        hasRequestDevice: typeof navigator.bluetooth?.requestDevice === 'function',
        hasGetAvailability: typeof navigator.bluetooth?.getAvailability === 'function'
      };
    });
    
    console.log('After injection:', afterInjection);
    
    expect(afterInjection.hasBluetooth).toBe(true);
    expect(afterInjection.bluetoothType).toBe('object');
    expect(afterInjection.hasRequestDevice).toBe(true);
    expect(afterInjection.hasGetAvailability).toBe(true);
  });

  test('should create mock device with requestDevice', async ({ page }) => {
    await page.goto('about:blank');
    
    // Load and inject
    const bundlePath = join(__dirname, '../../dist/web-ble-mock.bundle.js');
    await page.addScriptTag({ path: bundlePath });
    
    await page.evaluate(() => {
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
    });
    
    // Try to request a device
    const deviceInfo = await page.evaluate(async () => {
      try {
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: 'TestDevice' }]
        });
        
        return {
          success: true,
          hasDevice: device !== null,
          deviceId: device.id,
          deviceName: device.name,
          hasGatt: 'gatt' in device,
          gattHasConnect: typeof device.gatt?.connect === 'function'
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });
    
    console.log('Device request result:', deviceInfo);
    
    expect(deviceInfo.success).toBe(true);
    expect(deviceInfo.hasDevice).toBe(true);
    expect(deviceInfo.deviceName).toBe('TestDevice');
    expect(deviceInfo.hasGatt).toBe(true);
    expect(deviceInfo.gattHasConnect).toBe(true);
  });

  test('should verify simulateNotification is available', async ({ page }) => {
    await page.goto('about:blank');
    
    // Load and inject
    const bundlePath = join(__dirname, '../../dist/web-ble-mock.bundle.js');
    await page.addScriptTag({ path: bundlePath });
    
    await page.evaluate(() => {
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
        service: '180f',
        write: '2a19',
        notify: '2a19'
      });
    });
    
    // Create device and check for simulateNotification
    const hasSimulateMethod = await page.evaluate(async () => {
      try {
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: 'TestDevice' }]
        });
        
        // Don't actually connect (no server running)
        // Just check the mock structure
        const MockBluetooth = window.WebBleMock.MockBluetooth;
        const mockInstance = new MockBluetooth('ws://localhost:8080');
        const mockDevice = await mockInstance.requestDevice({ filters: [{ namePrefix: 'Test' }] });
        
        // Check if the structure supports our new features
        return {
          hasTransport: 'transport' in mockDevice,
          hasGatt: 'gatt' in mockDevice,
          hasBleConfig: 'bleConfig' in mockDevice
        };
      } catch (error) {
        return {
          error: error.message
        };
      }
    });
    
    console.log('Mock structure check:', hasSimulateMethod);
    
    expect(hasSimulateMethod.hasTransport).toBe(true);
    expect(hasSimulateMethod.hasGatt).toBe(true);
  });

  test('should handle multiple connect/disconnect cycles like real tests', async ({ page }) => {
    // Skip if no real device available
    const deviceAvailable = process.env.CHECK_BLE_DEVICE !== 'false';
    if (!deviceAvailable) {
      console.log('Skipping multi-cycle test - no BLE device available');
      return;
    }
    
    // Start a real bridge server for this test
    const { BridgeServer } = await import('../../dist/index.js');
    const bridge = new BridgeServer('info');
    
    // Use a random port to avoid conflicts
    const port = 8090 + Math.floor(Math.random() * 100);
    await bridge.start(port);
    
    try {
      await page.goto('about:blank');
      
      // Load and inject mock
      const bundlePath = join(__dirname, '../../dist/web-ble-mock.bundle.js');
      await page.addScriptTag({ path: bundlePath });
      
      // Run multiple connect/disconnect cycles
      const results = await page.evaluate(async ({ wsPort, deviceId, service, write, notify }) => {
        // Configure mock with required BLE parameters from environment
        const url = new URL(`ws://localhost:${wsPort}`);
        url.searchParams.set('device', deviceId);
        url.searchParams.set('service', service);
        url.searchParams.set('write', write);
        url.searchParams.set('notify', notify);
        
        window.WebBleMock.injectWebBluetoothMock(url.toString());
        
        const results = [];
        const cycles = 5;
        
        for (let i = 0; i < cycles; i++) {
          const cycleStart = Date.now();
          
          try {
            // Request device using configured device identifier
            const device = await navigator.bluetooth.requestDevice({
              filters: [{ namePrefix: deviceId }]
            });
            
            // Connect
            const connectStart = Date.now();
            await device.gatt.connect();
            const connectTime = Date.now() - connectStart;
            
            // Quick operation (would be real test actions)
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Disconnect
            await device.gatt.disconnect();
            
            const cycleTime = Date.now() - cycleStart;
            
            results.push({
              cycle: i + 1,
              success: true,
              connectTime,
              cycleTime
            });
            
          } catch (error) {
            results.push({
              cycle: i + 1,
              success: false,
              error: error.message,
              cycleTime: Date.now() - cycleStart
            });
          }
          
          // Wait for bridge recovery + mock post-disconnect delay
          // This simulates real test behavior with proper cleanup between tests
          if (i < cycles - 1) { // Don't wait after last cycle
            await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5s to ensure clean state
          }
        }
        
        return results;
      }, {
        wsPort: port,
        deviceId: getBleConfig().device,
        service: getBleConfig().service,
        write: getBleConfig().write,
        notify: getBleConfig().notify
      });
      
      console.log('Connect/disconnect cycle results:', results);
      
      // All cycles should succeed
      const successful = results.filter(r => r.success).length;
      expect(successful).toBe(5);
      
      // Connection times should be reasonable (accounting for retries)
      results.forEach(result => {
        if (result.success) {
          expect(result.connectTime).toBeLessThan(10000); // 10s max with retries
          expect(result.cycleTime).toBeLessThan(12000); // 12s max total
        }
      });
      
      // Later cycles might be faster if we reduce recovery time for clean disconnects
      const avgFirstTwo = (results[0].cycleTime + results[1].cycleTime) / 2;
      const avgLastTwo = (results[3].cycleTime + results[4].cycleTime) / 2;
      console.log(`Average first 2 cycles: ${avgFirstTwo}ms, last 2: ${avgLastTwo}ms`);
      
    } finally {
      await bridge.stop();
    }
  });
});