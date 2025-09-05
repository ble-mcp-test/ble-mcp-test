/**
 * Test that validates different session IDs are properly rejected
 * when a session is already active
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { E2E_TEST_CONFIG, getBleConfig } from './test-config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Session ID Rejection', () => {
  const bundlePath = path.join(__dirname, '../../dist/web-ble-mock.bundle.js');
  
  test('should reject connection with different session ID when one is active', async ({ page }) => {
    console.log('[Session Test] Testing session ID rejection behavior');
    
    // Skip if bridge server not available
    try {
      await page.goto('http://localhost:8080', { waitUntil: 'networkidle', timeout: 2000 });
    } catch (e) {
      console.log('[Session Test] Bridge server not available, skipping test');
      test.skip();
      return;
    }
    
    // Setup page to serve the mock bundle
    await page.route('**/*', async (route) => {
      if (route.request().url().includes('/bundle.js')) {
        await route.fulfill({
          body: await page.evaluate(() => {
            return fetch(bundlePath).then(r => r.text());
          }),
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
              <div id="result">Session Rejection Test</div>
            </body>
            </html>
          `,
          contentType: 'text/html',
        });
      }
    });

    await page.goto('http://localhost/test');
    await page.waitForTimeout(100);
    
    // First, inject mock with the standard deterministic session ID
    await page.evaluate((config) => {
      window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', config);
    }, getBleConfig());
    
    const results = await page.evaluate(async () => {
      const log: string[] = [];
      
      try {
        // === FIRST CONNECTION WITH STANDARD SESSION ID ===
        log.push('=== FIRST CONNECTION (STANDARD SESSION) ===');
        
        // Request device
        log.push('Requesting device with standard session...');
        const device1 = await navigator.bluetooth.requestDevice({
          filters: [{ services: ['0x9800'] }]
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
        window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
          service: '9800',
          write: '9900', 
          notify: '9901',
          sessionId: 'different-session-id'  // DIFFERENT SESSION ID
        });
        
        // Try to request device again with different session
        log.push('Requesting device with DIFFERENT session ID...');
        let secondConnectionFailed = false;
        let errorMessage = '';
        
        try {
          const device2 = await navigator.bluetooth.requestDevice({
            filters: [{ services: ['0x9800'] }]
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
            filters: [{ services: ['0x9800'] }]
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
    });
    
    // Log full results
    console.log('[Session Test] Results:');
    results.log.forEach(line => console.log(`  ${line}`));
    
    // Test assertions
    expect(results.secondConnectionFailed).toBe(true);
    expect(results.errorMessage).toContain('busy');
    console.log('[Session Test] ✓ Session ID rejection working correctly');
  });
});