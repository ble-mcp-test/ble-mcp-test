import { test, expect } from '@playwright/test';
import { getBleConfig, setupMockPage, testCommandHelper } from './test-config';

test.describe('Connection Lifecycle - Comprehensive Connection Testing', () => {
  test('should handle basic device connection and command execution', async ({ page }) => {
    // Basic connection test - verifies fundamental connectivity
    await setupMockPage(page, '<html><body>Basic Connection Test</body></html>');
    
    console.log('[TEST] Testing basic device connection and command execution');
    
    const deviceWorked = await testCommandHelper(page);
    expect(deviceWorked).toBe(true);
    
    console.log('[TEST] Basic connection test passed');
  });

  test('should handle sequential reconnections with delays', async ({ page }) => {
    // Tests sequential connections to verify no zombie sessions occur
    console.log('[TEST] Starting sequential reconnections test');
    
    await setupMockPage(page);
    
    // Three sequential connections with delays (zombie test pattern)
    console.log('=== FIRST CONNECTION ===');
    const result1 = await testCommandHelper(page);
    
    console.log('Waiting 1 second...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('=== SECOND CONNECTION ===');
    const result2 = await testCommandHelper(page);
    
    console.log('=== THIRD CONNECTION ===');
    const result3 = await testCommandHelper(page);
    
    // All connections should succeed
    expect(result1).toBe(true);
    expect(result2).toBe(true); 
    expect(result3).toBe(true);
    
    console.log('[TEST] Sequential reconnections test passed');
  });

  test('should handle back-to-back connect/disconnect cycles with no delay', async ({ page }) => {
    // The bridge holds ONE writer slot (TRA-1159), not a pool keyed on session.
    // What this covers is that releasing the command path is immediate enough to
    // reclaim it on the very next call, with no grace period to hide behind.
    await setupMockPage(page, '<html><body>Rapid Reconnection Test</body></html>');

    console.log('[TEST] Testing immediate command-path reclaim');

    const result1 = await testCommandHelper(page);
    console.log('First rapid command result:', result1);

    // No delay - the previous helper released on its way out, so this must work
    const result2 = await testCommandHelper(page);
    console.log('Second rapid command result:', result2);

    await new Promise(resolve => setTimeout(resolve, 500));
    const result3 = await testCommandHelper(page);
    console.log('Third rapid command result:', result3);

    expect(result1).toBe(true);
    expect(result2).toBe(true);
    expect(result3).toBe(true);

    console.log('[TEST] Rapid reconnections test passed - command path reclaimed each time');
  });

  test('should handle explicit disconnect and reconnect cycles', async ({ page }) => {
    // Tests explicit disconnect/reconnect to verify session reuse
    await setupMockPage(page, '<html><body>Disconnect-Reconnect Test</body></html>');

    const result = await page.evaluate(async ({ config }) => {
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

        // STEP 2: Explicit disconnect
        console.log('[TEST] Step 2: Disconnecting...');
        await bleDevice.gatt.disconnect();
        await new Promise(resolve => setTimeout(resolve, 1000)); // Let disconnect propagate
        results.disconnected = !bleDevice.gatt.connected;
        console.log('[TEST] Disconnected');

        // STEP 3: Reconnect with same session
        console.log('[TEST] Step 3: Reconnecting with same session...');
        
        bleDevice = await navigator.bluetooth.requestDevice({
          filters: [{ services: [config.service] }]
        });
        
        await bleDevice.gatt.connect();
        
        results.secondConnect = {
          connected: bleDevice.gatt.connected,
          deviceName: bleDevice.name,
          sameDevice: results.firstConnect.deviceName === bleDevice.name
        };
        console.log('[TEST] Second connection successful:', bleDevice.name);

        // STEP 4: Verify characteristics still work
        const server = bleDevice.gatt;
        const service = await server.getPrimaryService(config.service);
        const writeChar = await service.getCharacteristic(config.write);
        const notifyChar = await service.getCharacteristic(config.notify);
        
        results.characteristicsFound = true;
        await bleDevice.gatt.disconnect();
        
      } catch (error) {
        results.error = {
          message: error.message,
          stack: error.stack
        };
        console.error('[TEST] Error:', error);
      }
      
      return results;
    }, { config: getBleConfig() });

    // Verify the disconnect/reconnect cycle worked
    expect(result.error).toBeUndefined();
    expect(result.firstConnect.connected).toBe(true);
    expect(result.disconnected).toBe(true);
    expect(result.secondConnect.connected).toBe(true);
    expect(result.secondConnect.sameDevice).toBe(true);
    expect(result.characteristicsFound).toBe(true);
    
    // Test command execution after disconnect-reconnect
    const canWriteAfterReconnect = await testCommandHelper(page);
    expect(canWriteAfterReconnect).toBe(true);
    
    console.log('[TEST] Explicit disconnect/reconnect test passed');
  });

  test('should stay reconnectable after multiple disconnect cycles', async ({ page }) => {
    // Tests that the transport stays usable after repeated disconnect cycles.
    await setupMockPage(page, '<html><body>Reconnect Integrity Test</body></html>');

    const result = await page.evaluate(async ({ config }) => {
      const results: any = { 
        sessionId: config.sessionId,
        connections: []
      };

      try {
        // Multiple connect/disconnect cycles to trigger cleanup code paths
        for (let i = 0; i < 3; i++) {
          console.log(`[TEST] Connection cycle ${i + 1}/3`);
          
          const bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ services: [config.service] }]
          });
          
          await bleDevice.gatt.connect();
          const connected = bleDevice.gatt.connected;
          console.log(`[TEST] Connected: ${connected}`);
          
          // Explicit disconnect to trigger cleanup
          await bleDevice.gatt.disconnect();
          await new Promise(resolve => setTimeout(resolve, 500)); // Let cleanup complete
          
          results.connections.push({
            cycle: i + 1,
            connected: connected,
            deviceName: bleDevice.name || 'unnamed'
          });
          
          // Pause before next cycle
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Final connection to verify the transport still works after all cycles
        console.log('[TEST] Final connection to verify transport state...');
        const finalDevice = await navigator.bluetooth.requestDevice({
          filters: [{ services: [config.service] }]
        });
        
        await finalDevice.gatt.connect();
        results.finalConnection = {
          connected: finalDevice.gatt.connected,
          deviceName: finalDevice.name || 'unnamed'
        };
        
        // Verify full functionality
        const server = finalDevice.gatt;
        const service = await server.getPrimaryService(config.service);
        const writeChar = await service.getCharacteristic(config.write);
        const notifyChar = await service.getCharacteristic(config.notify);
        
        results.characteristicsFound = true;
        await finalDevice.gatt.disconnect();
        
      } catch (error) {
        results.error = {
          message: error.message,
          stack: error.stack
        };
        console.error('[TEST] Error:', error);
      }
      
      return results;
    }, { config: getBleConfig() });

    // Verify all cycles succeeded and the transport is still usable
    expect(result.error).toBeUndefined();
    expect(result.connections).toHaveLength(3);
    result.connections.forEach((conn: any) => {
      expect(conn.connected).toBe(true);
    });
    expect(result.finalConnection.connected).toBe(true);
    expect(result.characteristicsFound).toBe(true);
    
    // Final test with command helper
    const canWriteAfterCycles = await testCommandHelper(page);
    expect(canWriteAfterCycles).toBe(true);
    
    console.log('[TEST] Multiple disconnect cycles test passed - transport still reconnectable');
  });
});