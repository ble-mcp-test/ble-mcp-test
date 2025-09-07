import { test, expect } from '@playwright/test';
import { getBleConfig, setupMockPage, testCommandHelper } from './test-config';

test.describe('Session Pool Behavior - Verify Proper BLE Connection Pooling', () => {
  test('should keep BLE connection alive during grace period', async ({ page }) => {
    // This test verifies basic session pooling by doing multiple commands quickly
    // If pooling works, all commands should succeed
    
    // Setup page with bundle and auto-inject mock
    await setupMockPage(page, '<html><body>Session Pool Test</body></html>');

    console.log('[TEST] Testing session pooling with rapid commands');
    
    // Test rapid successive commands to verify pooling
    const result1 = await testCommandHelper(page);
    console.log('First command result:', result1);
    
    // No delay - test immediate reconnection
    const result2 = await testCommandHelper(page);
    console.log('Second command result:', result2);
    
    // Small delay - test grace period
    await new Promise(resolve => setTimeout(resolve, 500));
    const result3 = await testCommandHelper(page);
    console.log('Third command result:', result3);

    // All commands should work if pooling is working
    expect(result1).toBe(true);
    expect(result2).toBe(true); 
    expect(result3).toBe(true);
    
    console.log('[TEST] Session pooling test passed - all commands succeeded');
  });
});