import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env.local') });

test.describe('Service-Only Filtering', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');
  
  test('should connect to any device with matching service UUID', async ({ page }) => {
    // Skip if no bridge server
    const health = await fetch('http://localhost:8081/health').catch(() => null);
    if (!health || !health.ok) {
      test.skip(true, 'Bridge server not running');
      return;
    }

    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.endsWith('/bundle.js')) {
        await route.fulfill({
          path: bundlePath,
          contentType: 'application/javascript',
        });
      } else {
        await route.fulfill({
          body: `
            <!DOCTYPE html>
            <html>
            <head>
              <script src="/bundle.js"></script>
            </head>
            <body>
              <button id="connect">Connect</button>
              <div id="result"></div>
            </body>
            </html>
          `,
          contentType: 'text/html',
        });
      }
    });

    await page.goto('http://localhost/test');
    await page.waitForTimeout(100);

    const result = await page.evaluate(async () => {
      const output: any = {};
      
      try {
        // Inject mock WITHOUT device config
        window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
          service: '9800',
          write: '9900',
          notify: '9901',
          sessionId: 'service-only-test'
        });
        
        output.mockInjected = true;
        
        // Request device with service UUID filter only
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ services: ['9800'] }]
        });
        
        output.deviceFound = true;
        output.deviceId = device.id;
        output.deviceName = device.name;
        
        // Connect
        await device.gatt.connect();
        output.connected = device.gatt.connected;
        
        // Clean disconnect
        await device.gatt.disconnect();
        output.disconnected = !device.gatt.connected;
        
      } catch (error: any) {
        output.error = error.message;
      }
      
      return output;
    });

    console.log('Service-only filter result:', result);
    
    // Verify device was found
    expect(result.mockInjected).toBe(true);
    expect(result.deviceFound).toBe(true);
    expect(result.deviceName).not.toBe('MockDevice000000');
    
    // Connection might fail if no real device with service 9800 is available
    if (result.error) {
      console.log('Expected behavior: Connection failed because no real device found');
      expect(result.error).toContain('timeout');
    } else {
      // If a real device was found, verify connection worked
      expect(result.connected).toBe(true);
      expect(result.disconnected).toBe(true);
    }
  });
  
  test('should work with empty filters array', async ({ page }) => {
    // Skip if no bridge server
    const health = await fetch('http://localhost:8081/health').catch(() => null);
    if (!health || !health.ok) {
      test.skip(true, 'Bridge server not running');
      return;
    }

    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.endsWith('/bundle.js')) {
        await route.fulfill({
          path: bundlePath,
          contentType: 'application/javascript',
        });
      } else {
        await route.fulfill({
          body: `
            <!DOCTYPE html>
            <html>
            <head>
              <script src="/bundle.js"></script>
            </head>
            <body>
              <div id="result"></div>
            </body>
            </html>
          `,
          contentType: 'text/html',
        });
      }
    });

    await page.goto('http://localhost/test');
    await page.waitForTimeout(100);

    const result = await page.evaluate(async () => {
      const output: any = {};
      
      try {
        window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
          service: '9800',
          write: '9900',
          notify: '9901',
          sessionId: 'empty-filters-test'
        });
        
        // Request with no filters at all
        const device = await navigator.bluetooth.requestDevice({
          filters: []
        });
        
        output.deviceFound = true;
        output.deviceName = device.name;
        
      } catch (error: any) {
        output.error = error.message;
      }
      
      return output;
    });

    console.log('Empty filters result:', result);
    
    // Should work - mock bypasses the need for filters
    expect(result.deviceFound).toBe(true);
    // Device name might be empty when no filter specified
    expect(result.deviceName).not.toBe('MockDevice000000');
  });
});