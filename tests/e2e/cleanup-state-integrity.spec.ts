import { test, expect } from '@playwright/test';
import { getBleConfig, setupMockPage } from './test-config';

test.describe('Cleanup State Integrity - Verify Noble State After Cleanup', () => {
  test('should maintain Noble state integrity after cleanup operations', async ({ page }) => {
    // This test catches the bug where completeNobleReset corrupts Noble's internal state
    
    // Setup page with bundle and auto-inject mock  
    await setupMockPage(page, '<html><body>Noble State Integrity Test</body></html>');

    const result = await page.evaluate(async (config) => {
      const results: any = { 
        sessionId: config.sessionId,
        connections: []
      };

      try {
        // CRITICAL: This pattern triggers the cleanup code path multiple times
        // Each disconnect should trigger cleanup which calls completeNobleReset
        
        for (let i = 0; i < 3; i++) {
          console.log(`[TEST] Connection attempt ${i + 1}/3`);
          
          // Request device - this will trigger scanning which uses _peripherals
          const bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ services: [config.service] }]
          });
          
          // Connect
          await bleDevice.gatt.connect();
          const connected = bleDevice.gatt.connected;
          console.log(`[TEST] Connected: ${connected}`);
          
          // Disconnect - triggers cleanup -> completeNobleReset
          await bleDevice.gatt.disconnect();
          await new Promise(resolve => setTimeout(resolve, 500)); // Let cleanup complete
          
          results.connections.push({
            attempt: i + 1,
            connected: connected,
            deviceName: bleDevice.name || 'unnamed'
          });
          
          // Brief pause before next connection to ensure cleanup completes
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Final connection to verify Noble still works
        console.log('[TEST] Final connection to verify Noble state...');
        const finalDevice = await navigator.bluetooth.requestDevice({
          filters: [{ services: [config.service] }]
        });
        
        await finalDevice.gatt.connect();
        results.finalConnection = {
          connected: finalDevice.gatt.connected,
          deviceName: finalDevice.name || 'unnamed'
        };
        
        // Try to use the device to ensure full functionality
        const server = finalDevice.gatt;
        const service = await server.getPrimaryService(config.service);
        const writeChar = await service.getCharacteristic(config.write);
        await writeChar.writeValue(new Uint8Array([0xA7, 0xB3, 0x02, 0x6A, 0x82, 0x37, 0x00, 0x00, 0x90, 0x01]));
        results.canWrite = true;
        
        await finalDevice.gatt.disconnect();
        
      } catch (error) {
        results.error = {
          message: error.message,
          stack: error.stack,
          // Check if it's the specific Noble state corruption error
          isNobleStateError: error.message?.includes('_peripherals.get is not a function') ||
                            error.message?.includes('Cannot read properties of undefined')
        };
        console.error('[TEST] Error:', error);
      }
      
      return results;
    }, getBleConfig());

    console.log('Test results:', JSON.stringify(result, null, 2));

    // Verify the test passed
    expect(result.error).toBeUndefined();
    expect(result.connections).toHaveLength(3);
    result.connections.forEach((conn: any) => {
      expect(conn.connected).toBe(true);
    });
    expect(result.finalConnection.connected).toBe(true);
    expect(result.canWrite).toBe(true);
    
    // If this test fails with isNobleStateError=true, 
    // it means completeNobleReset is corrupting Noble's state
    if (result.error?.isNobleStateError) {
      throw new Error('Noble state corruption detected - _peripherals is not a Map after cleanup');
    }
  });
});