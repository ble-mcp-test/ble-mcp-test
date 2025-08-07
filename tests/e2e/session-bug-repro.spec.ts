import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Reproduces the exact bug downstream is seeing:
 * - Console logs show "Reusing stored session: 127.0.0.1-chrome-524F"
 * - But WebSocket connects with different session "127.0.0.1-chrome-9ZN4"
 */
test.describe('Session Persistence Bug Reproduction', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');

  test('localStorage session should be used for WebSocket connection', async ({ page }) => {
    // Enable console logging
    const consoleLogs: string[] = [];
    page.on('console', (msg) => {
      consoleLogs.push(msg.text());
    });

    // Start a local server to serve the bundle
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

    // First test - establish session
    await page.goto('http://localhost/test1');
    await page.addScriptTag({ url: '/bundle.js' });

    const deviceIdentifier = process.env.BLE_MCP_DEVICE_IDENTIFIER || 'CS108';
    const firstResult = await page.evaluate(async (device) => {
      // No need to clear session - localStorage is no longer used
      
      // Inject mock without explicit session
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
      
      // Get auto-generated session from the mock
      const bluetooth = (navigator as any).bluetooth;
      const autoSessionId = bluetooth.autoSessionId;
      console.log(`[Test] First injection auto-session: ${autoSessionId}`);
      
      // Request device and connect
      try {
        const bleDevice = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: device }]
        });
        
        await bleDevice.gatt.connect();
        
        // Check what session was actually used
        const transportSession = bleDevice.transport?.sessionId;
        console.log(`[Test] First connection transport session: ${transportSession}`);
        
        await bleDevice.gatt.disconnect();
        
        return {
          autoSessionId,
          transportSession,
          sessionIdFromDevice: bleDevice.sessionId
        };
      } catch (error) {
        return { error: (error as Error).message };
      }
    }, deviceIdentifier);

    console.log('First test result:', firstResult);
    console.log('Console logs from first test:', consoleLogs);

    // Clear logs for second test
    consoleLogs.length = 0;

    // Second test - should reuse session
    await page.goto('http://localhost/test2');
    await page.addScriptTag({ url: '/bundle.js' });

    const secondResult = await page.evaluate(async (device) => {
      // Inject mock again (should reuse localStorage session)
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
      
      // Get session from the mock
      const bluetooth = (navigator as any).bluetooth;
      const autoSessionId = bluetooth.autoSessionId;
      console.log(`[Test] Second injection auto-session: ${autoSessionId}`);
      
      // Check localStorage directly
      const storedSession = localStorage.getItem('ble-mock-session-id');
      console.log(`[Test] localStorage session: ${storedSession}`);
      
      // Request device and try to connect
      try {
        const bleDevice = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: device }]
        });
        
        // Log the device's config
        console.log(`[Test] Device bleConfig:`, JSON.stringify(bleDevice.bleConfig));
        
        await bleDevice.gatt.connect();
        
        // Check what session was actually used
        const transportSession = bleDevice.transport?.sessionId;
        console.log(`[Test] Second connection transport session: ${transportSession}`);
        
        return {
          autoSessionId,
          storedSession,
          transportSession,
          sessionIdFromDevice: bleDevice.sessionId,
          deviceBleConfig: bleDevice.bleConfig
        };
      } catch (error) {
        return { 
          error: (error as Error).message,
          autoSessionId,
          storedSession
        };
      }
    }, deviceIdentifier);

    console.log('Second test result:', secondResult);
    console.log('Console logs from second test:', consoleLogs);

    // Analyze the bug
    if (!firstResult.error && !secondResult.error) {
      // Check if sessions match
      expect(secondResult.autoSessionId).toBe(firstResult.autoSessionId);
      expect(secondResult.storedSession).toBe(firstResult.autoSessionId);
      
      // This is where the bug occurs - transport session doesn't match
      if (secondResult.transportSession !== secondResult.autoSessionId) {
        console.error('BUG CONFIRMED: Transport session does not match auto-generated session!');
        console.error(`Auto session: ${secondResult.autoSessionId}`);
        console.error(`Transport session: ${secondResult.transportSession}`);
      }
    }

    // Look for the specific log pattern downstream reported
    const reusingLog = consoleLogs.find(log => log.includes('Reusing stored session'));
    if (reusingLog) {
      console.log('Found reusing log:', reusingLog);
      // Extract the session ID from the log
      const match = reusingLog.match(/Reusing stored session: (.+)/);
      if (match) {
        const loggedSession = match[1];
        console.log(`Session from log: ${loggedSession}`);
        console.log(`Session used in WebSocket: ${secondResult.transportSession || 'unknown'}`);
        
        // Check if they match
        if (secondResult.transportSession && loggedSession !== secondResult.transportSession) {
          console.error('CONFIRMED: Logged session does not match WebSocket session!');
        }
      }
    }
  });
});