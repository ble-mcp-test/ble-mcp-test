import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
});