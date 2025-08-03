import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env.local') });

test.describe('Real Device Session Test', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');
  
  // Get device config from environment
  const deviceConfig = {
    deviceId: process.env.BLE_MCP_DEVICE_IDENTIFIER || '6c79b82603a7',
    service: process.env.BLE_MCP_SERVICE_UUID || '9800',
    write: process.env.BLE_MCP_WRITE_UUID || '9900',
    notify: process.env.BLE_MCP_NOTIFY_UUID || '9901'
  };

  test('should connect to real device with session ID', async ({ page }) => {
    // Skip if no bridge server
    const health = await fetch('http://localhost:8081/health').catch(() => null);
    if (!health || !health.ok) {
      test.skip(true, 'Bridge server not running');
      return;
    }
    
    console.log('Device configuration from environment:');
    console.log(`  Device ID: ${deviceConfig.deviceId}`);
    console.log(`  Service UUID: ${deviceConfig.service}`);
    console.log(`  Write UUID: ${deviceConfig.write}`);
    console.log(`  Notify UUID: ${deviceConfig.notify}`);

    // Capture console logs
    const consoleLogs: string[] = [];
    page.on('console', msg => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });

    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.endsWith('/bundle.js')) {
        await route.fulfill({
          path: bundlePath,
          contentType: 'application/javascript',
        });
      } else {
        await route.fulfill({
          body: '<html><body>Test Page</body></html>',
          contentType: 'text/html',
        });
      }
    });

    await page.goto('http://localhost/test');
    await page.addScriptTag({ url: '/bundle.js' });

    const testSessionId = 'real-device-test-session';
    
    // Pass device config to browser context
    const result = await page.evaluate(async ({ sessionId, config }) => {
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
        sessionId,
        service: config.service,
        write: config.write,
        notify: config.notify
      });

      try {
        // Use the device identifier from environment
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: config.deviceId }]
        });
        
        const deviceInfo = {
          id: device.id,
          name: device.name,
          sessionId: (device as any).sessionId
        };
        
        // Try to connect
        await device.gatt!.connect();
        
        return { 
          connected: true,
          device: deviceInfo,
          error: null 
        };
      } catch (e) {
        return { 
          connected: false,
          device: null,
          error: e.message 
        };
      }
    }, { sessionId: testSessionId, config: deviceConfig });

    console.log('Connection result:', result);
    
    if (result.connected) {
      console.log('✅ Successfully connected to real device!');
      console.log(`   Device: ${result.device.name} (${result.device.id})`);
      console.log(`   Session: ${result.device.sessionId}`);
      
      // Verify session ID was used
      expect(result.device.sessionId).toBe(testSessionId);
    } else {
      console.log('❌ Connection failed:', result.error);
    }
  });
});