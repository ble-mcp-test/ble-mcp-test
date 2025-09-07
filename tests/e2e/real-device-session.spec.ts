import { test, expect } from '@playwright/test';
import { E2E_TEST_CONFIG, getBleConfig, setupMockPage, testCommandHelper } from './test-config';

test.describe('Real Device Session Test', () => {
  test('should connect using service-only filtering (no device name)', async ({ page }) => {
    // Test will fail if bridge server not available - that's intentional for troubleshooting

    // Setup page with bundle and inject mock using shared helper
    await setupMockPage(page);

    console.log('[TEST] Testing service-only filtering connection');
    
    // Use testCommandHelper to verify device connection and command works
    const deviceWorked = await testCommandHelper(page);
    expect(deviceWorked).toBe(true);
    
    console.log('[TEST] Service-only filtering test passed');
  });

  test('should connect to real device with session ID and verify TX/RX logging', async ({ page }) => {
    // This test connects to a real device, sends a command, and verifies logging
    
    await setupMockPage(page, '<html><body>Real Device Test</body></html>');

    console.log('[TEST] Testing real device connection and command');
    
    // Use testCommandHelper to verify device connection and command works
    const deviceWorked = await testCommandHelper(page);
    expect(deviceWorked).toBe(true);
    
    console.log('[TEST] Real device session test passed');
  });
});