/**
 * Test that validates different session IDs are properly rejected
 * when a session is already active
 */

import { test, expect } from '@playwright/test';
import { getBleConfig, setupMockPage, injectMockInPage } from './test-config';

test.describe('Session ID Rejection', () => {
  test('should reject connection with different session ID when one is active', async ({ page }) => {
    console.log('[Session Test] Testing session ID rejection behavior');
    
    // ONE LINE replaces 27 lines of boilerplate AND injects mock!
    await setupMockPage(page);
    
    const results = await page.evaluate(async (testConfig) => {
      const log: string[] = [];
      const { service, write, notify } = testConfig;
      
      try {
        // === FIRST CONNECTION WITH STANDARD SESSION ID ===
        log.push('=== FIRST CONNECTION (STANDARD SESSION) ===');
        
        // Request device
        log.push('Requesting device with standard session...');
        const device1 = await navigator.bluetooth.requestDevice({
          filters: [{ services: [service] }]
        });
        log.push(`Device found: ${device1.name || 'unnamed'}, ID: ${device1.id}`);
        
        // Connect GATT
        log.push('Connecting GATT...');
        const server1 = await device1.gatt!.connect();
        log.push(`GATT connected: ${server1.connected}`);
        
        // Keep connection alive but try to connect with different session
        log.push('');
        log.push('=== SECOND CONNECTION ATTEMPT (DIFFERENT SESSION) ===');
        
        // Re-inject mock with a DIFFERENT session ID
        window.WebBleMock.injectWebBluetoothMock({
          sessionId: 'different-session-id',  // DIFFERENT SESSION ID
          serverUrl: 'ws://localhost:8080',
          service,
          write, 
          notify
        });
        
        // Try to request device again with different session
        log.push('Requesting device with DIFFERENT session ID...');
        let secondConnectionFailed = false;
        let errorMessage = '';
        
        try {
          const device2 = await navigator.bluetooth.requestDevice({
            filters: [{ services: [service] }]
          });
          log.push(`ERROR: Should not have found device: ${device2.id}`);
          
          // Try to connect (should fail)
          await device2.gatt!.connect();
          log.push('ERROR: Second connection should have been rejected!');
        } catch (error: any) {
          secondConnectionFailed = true;
          errorMessage = error.message || String(error);
          log.push(`✓ Second connection properly rejected: ${errorMessage}`);
        }
        
        // Disconnect first connection
        log.push('');
        log.push('Disconnecting first connection...');
        device1.gatt!.disconnect();
        
        // Wait for cleanup
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Now try with different session again (should work after cleanup)
        log.push('');
        log.push('=== THIRD CONNECTION ATTEMPT (DIFFERENT SESSION AFTER CLEANUP) ===');
        
        try {
          const device3 = await navigator.bluetooth.requestDevice({
            filters: [{ services: [service] }]
          });
          log.push(`Device found with different session: ${device3.name || 'unnamed'}, ID: ${device3.id}`);
          
          const server3 = await device3.gatt!.connect();
          log.push(`✓ Different session ID accepted after cleanup: ${server3.connected}`);
          
          // Clean up
          device3.gatt!.disconnect();
        } catch (error: any) {
          log.push(`ERROR: Should have connected after cleanup: ${error.message}`);
        }
        
        return { 
          success: true, 
          secondConnectionFailed,
          errorMessage,
          log 
        };
        
      } catch (error: any) {
        log.push(`FATAL ERROR: ${error.message}`);
        log.push(`Stack: ${error.stack}`);
        return { 
          success: false, 
          secondConnectionFailed: false,
          errorMessage: '',
          log 
        };
      }
    }, getBleConfig());
    
    // Log full results
    console.log('[Session Test] Results:');
    results.log.forEach(line => console.log(`  ${line}`));
    
    // Test assertions
    expect(results.secondConnectionFailed).toBe(true);
    expect(results.errorMessage).toContain('busy');
    console.log('[Session Test] ✓ Session ID rejection working correctly');
  });
});