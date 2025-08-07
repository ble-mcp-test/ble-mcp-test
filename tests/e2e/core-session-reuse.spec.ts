import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env.local') });

test.describe('Core Session Reuse - THE ACTUAL USE CASE', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');
  
  // Get REAL config from environment
  const bleConfig = {
    device: process.env.BLE_MCP_DEVICE_IDENTIFIER || 'CS108',
    service: process.env.BLE_MCP_SERVICE_UUID || '9800',
    write: process.env.BLE_MCP_WRITE_UUID || '9900',
    notify: process.env.BLE_MCP_NOTIFY_UUID || '9901'
  };

  test('should reuse BLE session across test runs with explicit sessionId', async ({ page }) => {
    // This is what TrakRF actually does - pass sessionId and expect it to work
    
    // Setup page with bundle
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.endsWith('/bundle.js')) {
        await route.fulfill({
          path: bundlePath,
          contentType: 'application/javascript',
        });
      } else {
        await route.fulfill({
          body: '<html><body>Core Test</body></html>',
          contentType: 'text/html',
        });
      }
    });

    await page.goto('http://localhost/test');
    await page.addScriptTag({ url: '/bundle.js' });

    // Capture console logs to see what's happening
    const consoleLogs: string[] = [];
    page.on('console', msg => {
      consoleLogs.push(msg.text());
    });

    // TEST 1: First connection with explicit sessionId
    const testSessionId = 'trakrf-test-session-' + Date.now();
    console.log(`\n=== TEST 1: Connecting with sessionId: ${testSessionId} ===`);
    
    const result1 = await page.evaluate(async ({ sessionId, config }) => {
      // This is EXACTLY what a real client does
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');

      try {
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: config.device }]
        });
        
        // Actually connect
        await device.gatt.connect();
        
        return {
          success: true,
          connected: device.gatt.connected,
          deviceSessionId: (device as any).sessionId,
          deviceName: device.name
        };
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    }, { sessionId: testSessionId, config: bleConfig });

    console.log('First connection result:', result1);
    console.log('Console logs:', consoleLogs);
    
    // Verify sessionId was used
    expect(result1.success).toBe(true);
    expect(result1.connected).toBe(true);
    expect(result1.deviceSessionId).toBe(testSessionId);
    
    // Check logs for the mapping
    const mappingLog = consoleLogs.find(log => log.includes('[MockGATT] Using session ID for WebSocket:'));
    if (!mappingLog) {
      console.error('❌ MISSING LOG: [MockGATT] Using session ID for WebSocket');
      console.error('This means sessionId -> session mapping did NOT happen!');
    }
    expect(mappingLog).toBeTruthy();
    
    // TEST 2: Second connection with SAME sessionId (different page/test)
    await page.reload(); // Simulate new test
    await page.addScriptTag({ url: '/bundle.js' });
    
    console.log(`\n=== TEST 2: Reconnecting with same sessionId: ${testSessionId} ===`);
    
    const result2 = await page.evaluate(async ({ sessionId, config }) => {
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');

      try {
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: config.device }]
        });
        
        await device.gatt.connect();
        
        return {
          success: true,
          connected: device.gatt.connected,
          deviceSessionId: (device as any).sessionId,
          shouldReuseSession: true
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          note: 'If error is "Device is busy" then session reuse is working!'
        };
      }
    }, { sessionId: testSessionId, config: bleConfig });

    console.log('Second connection result:', result2);
    
    // The second connection should either:
    // 1. Successfully connect (reusing the session)
    // 2. Fail with "Device is busy" (if first connection is still active)
    // But it should NOT scan for a new device
    
    if (!result2.success && result2.error?.includes('Device is busy')) {
      console.log('✅ Session reuse is working - device is busy with our session');
    } else if (result2.success) {
      console.log('✅ Successfully reconnected with same session');
      expect(result2.deviceSessionId).toBe(testSessionId);
    } else {
      console.error('❌ Unexpected error:', result2.error);
      throw new Error('Session reuse failed with unexpected error');
    }
  });
});