import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Disconnect-Reconnect Same Session - The ACTUAL Bug', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');
  
  test('should handle disconnect event without breaking session reuse', async ({ page }) => {
    // This test catches the bug where Noble's disconnect event cleared the transport
    
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
          body: '<html><body>Disconnect-Reconnect Test</body></html>',
          contentType: 'text/html',
        });
      }
    });

    await page.goto('http://localhost/test');
    await page.addScriptTag({ url: '/bundle.js' });

    const testSessionId = 'e2e-test-session'; // Reuse same session for connection pooling
    const devicePrefix = process.env.BLE_MCP_DEVICE_IDENTIFIER || 'CS108';

    const result = await page.evaluate(async ({ sessionId, device }) => {
      const results: any = { sessionId };
      
      // Inject with explicit session
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
        sessionId: sessionId,
        service: '9800',
        write: '9900',
        notify: '9901'
      });

      try {
        // STEP 1: Initial connection
        console.log('[TEST] Step 1: Initial connection with session:', sessionId);
        let bleDevice = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: device }]
        });
        
        await bleDevice.gatt.connect();
        results.firstConnect = {
          connected: bleDevice.gatt.connected,
          deviceName: bleDevice.name
        };
        console.log('[TEST] First connection successful:', bleDevice.name);

        // STEP 2: Disconnect (triggers Noble disconnect event)
        console.log('[TEST] Step 2: Disconnecting...');
        await bleDevice.gatt.disconnect();
        await new Promise(resolve => setTimeout(resolve, 1000)); // Let disconnect propagate
        results.disconnected = !bleDevice.gatt.connected;
        console.log('[TEST] Disconnected');

        // STEP 3: Immediately reconnect with SAME session, SAME page
        console.log('[TEST] Step 3: Reconnecting with same session...');
        
        // Request device again (should return cached device)
        bleDevice = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: device }]
        });
        
        // This is where the bug occurred - Noble still connected but session cleared transport
        await bleDevice.gatt.connect();
        
        results.secondConnect = {
          connected: bleDevice.gatt.connected,
          deviceName: bleDevice.name,
          sameDevice: results.firstConnect.deviceName === bleDevice.name
        };
        console.log('[TEST] Second connection successful:', bleDevice.name);

        // STEP 4: Verify we can still communicate
        const server = bleDevice.gatt;
        const service = await server.getPrimaryService(0x9800);
        const writeChar = await service.getCharacteristic(0x9900);
        
        // Send a simple command
        await writeChar.writeValue(new Uint8Array([0xA7, 0xB3, 0x02, 0x6A, 0x82, 0x37, 0x00, 0x00, 0x90, 0x01]));
        results.canWrite = true;
        console.log('[TEST] Successfully wrote to device after reconnect');
        
        // Clean disconnect
        await bleDevice.gatt.disconnect();
        
      } catch (error) {
        results.error = {
          message: error.message,
          stack: error.stack
        };
        console.error('[TEST] Error:', error);
      }
      
      return results;
    }, { sessionId: testSessionId, device: devicePrefix });

    console.log('Test results:', JSON.stringify(result, null, 2));

    // Verify the test passed
    expect(result.error).toBeUndefined();
    expect(result.firstConnect.connected).toBe(true);
    expect(result.disconnected).toBe(true);
    expect(result.secondConnect.connected).toBe(true);
    expect(result.secondConnect.sameDevice).toBe(true);
    expect(result.canWrite).toBe(true);
  });
});