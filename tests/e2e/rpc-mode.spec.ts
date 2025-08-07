import { test, expect } from '@playwright/test';

// Test RPC mode where requestDevice options are passed via RPC
test.describe('RPC Mode', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to test page
    await page.goto('about:blank');
    
    // Inject the mock
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.src = '/dist/web-ble-mock.bundle.js';
      document.head.appendChild(script);
      return new Promise(resolve => {
        script.onload = resolve;
      });
    });
  });

  test('should pass full requestDevice options via RPC', async ({ page }) => {
    // Enable console logging
    page.on('console', msg => {
      if (msg.type() === 'log') {
        console.log(`[Browser] ${msg.text()}`);
      }
    });

    const result = await page.evaluate(async () => {
      // Inject mock
      (window as any).WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
      
      try {
        // Complex requestDevice options to test RPC
        const device = await navigator.bluetooth.requestDevice({
          filters: [
            { namePrefix: 'CS108', services: ['9800'] },
            { services: ['180f'] }  // Battery service
          ],
          optionalServices: ['180a']  // Device info service
        });
        
        // Connect
        await device.gatt.connect();
        
        // Get service to verify connection works
        const service = await device.gatt.getPrimaryService('9800');
        
        return { success: true, deviceId: device.id };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
    expect(result.deviceId).toBeTruthy();
  });

  test('should handle service-only filter via RPC', async ({ page }) => {
    page.on('console', msg => {
      if (msg.type() === 'log') {
        console.log(`[Browser] ${msg.text()}`);
      }
    });

    const result = await page.evaluate(async () => {
      (window as any).WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
      
      try {
        // Service-only filter
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ services: ['9800'] }]
        });
        
        await device.gatt.connect();
        const service = await device.gatt.getPrimaryService('9800');
        
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
  });

  test('should handle empty filters via RPC', async ({ page }) => {
    page.on('console', msg => {
      if (msg.type() === 'log') {
        console.log(`[Browser] ${msg.text()}`);
      }
    });

    const result = await page.evaluate(async () => {
      (window as any).WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
      
      try {
        // No filters - should still work via RPC
        const device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: ['9800']
        });
        
        await device.gatt.connect();
        const service = await device.gatt.getPrimaryService('9800');
        
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    });
    
    expect(result.success).toBe(true);
  });
});