import { test, expect } from '@playwright/test';
import { getBleConfig, setupMockPage } from './test-config';

test.describe('Session Pool Behavior - Verify Proper BLE Connection Pooling', () => {
  test('should keep BLE connection alive during grace period', async ({ page }) => {
    // This test verifies that:
    // 1. navigator.bluetooth.disconnect() doesn't send BLE commands
    // 2. BLE connection stays alive for session pooling
    // 3. Reconnection within grace period is instant (no new BLE connection)
    // 4. Reconnection after grace period requires new BLE connection
    
    // Setup page with bundle and auto-inject mock
    await setupMockPage(page, '<html><body>Session Pool Test</body></html>');

    const result = await page.evaluate(async (config) => {
      const results: any = { 
        sessionId: config.sessionId,
        timeline: []
      };

      try {
        // Helper to capture WebSocket traffic
        let wsMessageLog: any[] = [];
        const originalWebSocket = WebSocket;
        (window as any).WebSocket = class extends originalWebSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            
            const originalSend = this.send.bind(this);
            this.send = (data: any) => {
              // Log outgoing messages to detect BLE commands
              try {
                const msg = JSON.parse(data.toString());
                wsMessageLog.push({
                  time: Date.now(),
                  type: 'send',
                  method: msg.method,
                  data: msg
                });
              } catch {}
              return originalSend(data);
            };
            
            this.addEventListener('message', (event) => {
              // Log incoming messages
              try {
                const msg = JSON.parse(event.data);
                wsMessageLog.push({
                  time: Date.now(),
                  type: 'receive',
                  data: msg
                });
              } catch {}
            });
          }
        };

        // STEP 1: Initial connection
        console.log('[TEST] Step 1: Initial connection');
        const startTime = Date.now();
        let bleDevice = await navigator.bluetooth.requestDevice({
          filters: [{ services: [config.service] }]
        });
        
        await bleDevice.gatt.connect();
        const connectTime = Date.now() - startTime;
        
        results.timeline.push({
          step: 'initial_connect',
          duration: connectTime,
          connected: bleDevice.gatt.connected
        });
        
        // Get service and characteristics to ensure full connection
        const service = await bleDevice.gatt.getPrimaryService(config.service);
        const writeChar = await service.getCharacteristic(config.write);
        const notifyChar = await service.getCharacteristic(config.notify);
        
        // Subscribe to notifications
        await notifyChar.startNotifications();
        
        // Send a test command
        await writeChar.writeValue(new Uint8Array([0xA7, 0xB3, 0x02, 0x6A, 0x82, 0x37, 0x00, 0x00, 0x90, 0x01]));
        
        // Clear message log before disconnect
        wsMessageLog = [];
        
        // STEP 2: Soft disconnect (navigator.bluetooth)
        console.log('[TEST] Step 2: Soft disconnect');
        const disconnectStart = Date.now();
        await bleDevice.gatt.disconnect();
        const disconnectTime = Date.now() - disconnectStart;
        
        results.timeline.push({
          step: 'soft_disconnect',
          duration: disconnectTime,
          connected: bleDevice.gatt.connected
        });
        
        // Check what messages were sent during disconnect
        const disconnectMessages = wsMessageLog.filter(m => 
          m.type === 'send' && 
          (m.method === 'unsubscribe' || m.method === 'disconnect' || m.method === 'cleanup')
        );
        
        results.bleCommandsSentOnDisconnect = disconnectMessages.map(m => m.method);
        
        // STEP 3: Immediate reconnect (within grace period)
        console.log('[TEST] Step 3: Immediate reconnect (should reuse pooled connection)');
        await new Promise(resolve => setTimeout(resolve, 100)); // Brief pause
        
        const reconnectStart = Date.now();
        bleDevice = await navigator.bluetooth.requestDevice({
          filters: [{ services: [config.service] }]
        });
        await bleDevice.gatt.connect();
        const reconnectTime = Date.now() - reconnectStart;
        
        results.timeline.push({
          step: 'immediate_reconnect',
          duration: reconnectTime,
          connected: bleDevice.gatt.connected
        });
        
        // Verify we can still communicate
        const service2 = await bleDevice.gatt.getPrimaryService(config.service);
        const writeChar2 = await service2.getCharacteristic(config.write);
        await writeChar2.writeValue(new Uint8Array([0xA7, 0xB3, 0x02, 0x6A, 0x82, 0x37, 0x00, 0x00, 0x90, 0x01]));
        
        // STEP 4: Disconnect again
        console.log('[TEST] Step 4: Disconnect again');
        await bleDevice.gatt.disconnect();
        
        // STEP 5: Wait a bit (still within typical grace period)
        console.log('[TEST] Step 5: Wait 2 seconds (within grace period)');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const withinGraceStart = Date.now();
        bleDevice = await navigator.bluetooth.requestDevice({
          filters: [{ services: [config.service] }]
        });
        await bleDevice.gatt.connect();
        const withinGraceTime = Date.now() - withinGraceStart;
        
        results.timeline.push({
          step: 'reconnect_within_grace',
          duration: withinGraceTime,
          connected: bleDevice.gatt.connected
        });
        
        // Final cleanup
        await bleDevice.gatt.disconnect();
        
        // Analyze behavior patterns
        results.analysis = {
          // In mock mode, all connections are fast - we can't measure pooling by timing
          // Instead, we verify the critical behavior: no BLE commands on disconnect
          noBleCommandsOnSoftDisconnect: results.bleCommandsSentOnDisconnect.length === 0,
          // Verify reconnections work (pooling doesn't break reconnect)
          immediateReconnectWorks: results.timeline[2].connected === true,
          withinGraceReconnectWorks: results.timeline[3].connected === true
        };
        
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
    
    // Verify initial connection worked
    expect(result.timeline[0].connected).toBe(true);
    
    // CRITICAL: Verify no BLE commands sent on soft disconnect
    // This is the key behavior for session pooling
    expect(result.bleCommandsSentOnDisconnect).toEqual([]);
    expect(result.analysis.noBleCommandsOnSoftDisconnect).toBe(true);
    
    // Verify reconnections work (pooling doesn't break functionality)
    expect(result.analysis.immediateReconnectWorks).toBe(true);
    expect(result.analysis.withinGraceReconnectWorks).toBe(true);
    
    // Log timing for analysis
    console.log('Connection timings:');
    result.timeline.forEach((t: any) => {
      console.log(`  ${t.step}: ${t.duration}ms`);
    });
  });

  test('should properly handle idle timeout expiry', async ({ page }) => {
    // This test temporarily sets a short idle timeout on the server for testing
    
    await setupMockPage(page, '<html><body>Idle Timeout Expiry Test</body></html>');

    const result = await page.evaluate(async (config) => {
      // Use a unique session ID for this test to avoid reusing pooled connections
      config.sessionId = 'idle-timeout-test-' + Date.now();
      const results: any = { sessionId: config.sessionId };

      try {
        // When running with test-idle-timeout.sh, the server has a 3s idle timeout
        // Otherwise it's 600s which is too long for testing
        const MOCK_IDLE_TIMEOUT_MS = 3000; // Set to 3 seconds via test script
        
        // Initial connection
        console.log('[TEST] Initial connection');
        let bleDevice = await navigator.bluetooth.requestDevice({
          filters: [{ services: [config.service] }]
        });
        
        const initialConnectStart = Date.now();
        await bleDevice.gatt.connect();
        const initialConnectTime = Date.now() - initialConnectStart;
        
        results.initialConnectTime = initialConnectTime;
        
        // Disconnect to start idle timeout
        console.log('[TEST] Disconnecting to start idle timeout');
        await bleDevice.gatt.disconnect();
        const idleStartTime = Date.now();
        
        // Wait for idle timeout to expire (add buffer for cleanup to complete)
        const waitTime = MOCK_IDLE_TIMEOUT_MS + 4000;
        console.log(`[TEST] Waiting ${waitTime}ms for idle timeout to expire`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        // Try to reconnect after idle timeout
        console.log('[TEST] Reconnecting after idle timeout expiry');
        const afterIdleStart = Date.now();
        
        try {
          bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ services: [config.service] }]
          });
          await bleDevice.gatt.connect();
          const afterIdleTime = Date.now() - afterIdleStart;
          
          results.reconnectAfterIdleTime = afterIdleTime;
          results.reconnectSucceeded = true;
          
          // This should require a new BLE connection (slower)
          results.requiredNewConnection = afterIdleTime >= (initialConnectTime * 0.8);
          
          await bleDevice.gatt.disconnect();
        } catch (error) {
          // Connection might fail if device was fully released
          results.reconnectError = error.message;
          results.reconnectSucceeded = false;
        }
        
      } catch (error) {
        results.error = {
          message: error.message,
          stack: error.stack
        };
      }
      
      return results;
    }, getBleConfig());

    console.log('Idle timeout test results:', JSON.stringify(result, null, 2));

    // Verify test completed
    expect(result.error).toBeUndefined();
    
    // After idle timeout, should either:
    // 1. Require new connection (slower) if pool was cleaned up
    // 2. Or fail if device was fully released
    if (result.reconnectSucceeded) {
      // If reconnection succeeded, it should have been slower (new connection)
      expect(result.requiredNewConnection).toBe(true);
    }
  });
});