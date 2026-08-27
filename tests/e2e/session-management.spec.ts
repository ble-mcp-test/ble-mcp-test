import { test, expect } from '@playwright/test';
import { E2E_TEST_CONFIG, getBleConfig, setupMockPage } from './test-config';

test.describe('Session Management - Session ID and Reuse Testing', () => {
  test('should reuse BLE session across test runs with explicit sessionId', async ({ page }) => {
    // This is what TrakRF actually does - pass sessionId and expect it to work
    
    // Setup page with bundle and auto-inject mock
    await setupMockPage(page, '<html><body>Core Session Reuse Test</body></html>');

    // Capture console logs to see what's happening
    const consoleLogs: string[] = [];
    page.on('console', msg => {
      consoleLogs.push(msg.text());
    });
    
    // TEST: Connection with explicit sessionId
    const testSessionId = E2E_TEST_CONFIG.sessionId; // Use centralized session ID
    console.log(`\n=== TEST 1: Connecting with sessionId: ${testSessionId} ===`);
    
    const result1 = await page.evaluate(async ({ config }) => {
      try {
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [config.service] }]
        });
        
        // Actually connect
        await device.gatt.connect();
        
        return {
          success: true,
          connected: device.gatt.connected,
          deviceSessionId: (device as any).sessionId,
          deviceName: device.name
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    }, { config: getBleConfig() });

    console.log('First connection result:', result1);
    console.log('Console logs:', consoleLogs);
    
    // Verify sessionId was used
    expect(result1.success).toBe(true);
    expect(result1.connected).toBe(true);
    expect(result1.deviceSessionId).toBe(testSessionId);
    
    // Check logs for the mapping
    const mappingLog = consoleLogs.find(log => log.includes('[MockGATT] Using session ID for WebSocket:'));
    if (!mappingLog) {
      console.error('❌ MISSING LOG: [MockGATT] Using session ID for WebSocket');
      console.error('This means sessionId -> session mapping did NOT happen!');
    }
    expect(mappingLog).toBeTruthy();
    
    // For cross-test session reuse, the real test is:
    // 1. This test connects with sessionId X
    // 2. Other tests will use same sessionId X and should reuse the connection
    
    console.log('✅ First connection established with session:', testSessionId);
    console.log('Other tests in the suite will reuse this session');
  });

  test('should reject connection with different session ID when one is active', async ({ page }) => {
    // Tests that different session IDs are properly rejected when a session is active
    console.log('[Session Test] Testing session ID rejection behavior');
    
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
        await device1.gatt.connect();
        log.push(`GATT connected: ${device1.gatt.connected}`);
        
        // === SECOND CONNECTION ATTEMPT WITH DIFFERENT SESSION ID ===
        log.push('');
        log.push('=== SECOND CONNECTION ATTEMPT (DIFFERENT SESSION) ===');
        
        // Override sessionId for this attempt
        log.push('Requesting device with DIFFERENT session ID...');
        
        // Create new mock config with different session ID
        const differentSessionConfig = {
          sessionId: 'different-session-id-12345',
          serverUrl: testConfig.serverUrl,
          service: testConfig.service,
          write: testConfig.write,
          notify: testConfig.notify
        };
        
        // Re-inject mock with different session
        window.WebBleMock.injectWebBluetoothMock(differentSessionConfig);
        
        let secondConnectionResult = { success: false, error: '' };
        try {
          const device2 = await navigator.bluetooth.requestDevice({
            filters: [{ services: [service] }]
          });
          log.push(`ERROR: Should not have found device: ${device2.id}`);
          
          // Try to connect - this should fail
          await device2.gatt.connect();
          log.push('ERROR: Second connection should have failed');
          secondConnectionResult = { success: true, error: 'Should have failed' };
          
        } catch (error: any) {
          log.push(`✓ Second connection properly rejected: ${error.message}`);
          secondConnectionResult = { success: false, error: error.message };
        }
        
        // === CLEANUP AND THIRD ATTEMPT ===
        log.push('');
        log.push('Disconnecting first connection...');
        await device1.gatt.disconnect();
        
        // Brief pause for cleanup
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        log.push('');
        log.push('=== THIRD CONNECTION ATTEMPT (DIFFERENT SESSION AFTER CLEANUP) ===');
        
        let thirdConnectionResult = { success: false, error: '' };
        try {
          const device3 = await navigator.bluetooth.requestDevice({
            filters: [{ services: [service] }]
          });
          log.push(`Device found with different session: ${device3.name || 'unnamed'}, ID: ${device3.id}`);
          
          await device3.gatt.connect();
          log.push('Third connection succeeded after cleanup');
          thirdConnectionResult = { success: true, error: '' };
          
          await device3.gatt.disconnect();
          
        } catch (error: any) {
          log.push(`ERROR: Should have connected after cleanup: ${error.message}`);
          thirdConnectionResult = { success: false, error: error.message };
        }
        
        return {
          success: !secondConnectionResult.success, // Second should fail, so we invert
          log,
          firstConnection: { success: true },
          secondConnection: secondConnectionResult,
          thirdConnection: thirdConnectionResult
        };
        
      } catch (error: any) {
        log.push(`UNEXPECTED ERROR: ${error.message}`);
        return {
          success: false,
          log,
          error: error.message
        };
      }
    }, getBleConfig());

    console.log('[Session Test] Results:');
    results.log.forEach(line => console.log(`  ${line}`));

    // Verify session rejection behavior
    expect(results.success).toBe(true); // Second connection should have been rejected
    // Named before it is dereferenced: the harness returns no secondConnection at
    // all on its own failure path, and reading through it blind reports
    // "cannot read properties of undefined" instead of saying what went wrong.
    expect(results.secondConnection, 'the page never reached the second connection').toBeDefined();
    expect(results.secondConnection!.success).toBe(false); // Should have failed
    expect(results.secondConnection!.error).toContain('session'); // Should mention session issue
    
    console.log('[Session Test] ✓ Session ID rejection working correctly');
  });
});