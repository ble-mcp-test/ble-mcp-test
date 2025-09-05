import { test, expect } from '@playwright/test';
import { getBleConfig, setupMockPage } from './test-config';

test.describe('Disconnect-Reconnect Same Session - The ACTUAL Bug', () => {
  test('should handle disconnect event without breaking session reuse', async ({ page }) => {
    // This test catches the bug where Noble's disconnect event cleared the transport
    
    // Setup page with bundle and auto-inject mock  
    await setupMockPage(page, '<html><body>Disconnect-Reconnect Test</body></html>');

    const result = await page.evaluate(async (config) => {
      const results: any = { sessionId: config.sessionId };

      try {
        // STEP 1: Initial connection
        console.log('[TEST] Step 1: Initial connection with session:', config.sessionId);
        let bleDevice = await navigator.bluetooth.requestDevice({
          filters: [{ services: [config.service] }]
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
          filters: [{ services: [config.service] }]
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
        const service = await server.getPrimaryService(config.service);
        const writeChar = await service.getCharacteristic(config.write);
        
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
    }, getBleConfig());

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