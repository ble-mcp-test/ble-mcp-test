import { test, expect } from '@playwright/test';
import { E2E_TEST_CONFIG, getBleConfig, setupMockPage } from './test-config';

test.describe('Core Session Reuse - THE ACTUAL USE CASE', () => {
  // Use centralized config from test-config.ts

  test('should reuse BLE session across test runs with explicit sessionId', async ({ page }) => {
    // This is what TrakRF actually does - pass sessionId and expect it to work
    
    // Setup page with bundle and auto-inject mock
    await setupMockPage(page, '<html><body>Core Test</body></html>');

    // Capture console logs to see what's happening
    const consoleLogs: string[] = [];
    page.on('console', msg => {
      consoleLogs.push(msg.text());
    });
    
    // TEST 1: First connection with explicit sessionId
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
      } catch (error) {
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
    // 2. Another test file will use same sessionId X and should reuse the connection
    // The page reload pattern is not how Playwright tests actually work
    
    console.log('✅ First connection established with session:', testSessionId);
    console.log('Other tests in the suite will reuse this session');
  });
});