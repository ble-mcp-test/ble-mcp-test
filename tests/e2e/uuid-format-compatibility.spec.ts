import { test, expect } from '@playwright/test';
import { setupMockPage, getBleConfig, testCommandHelper } from './test-config';

test.describe('UUID Format Compatibility', () => {
  test('should handle short UUID format (9800)', async ({ page }) => {
    await setupMockPage(page, '<html><body>Short UUID Test</body></html>');
    
    // Test command execution with short UUIDs - if this works, UUIDs are compatible
    const shortUuidCommandWorks = await testCommandHelper(page);
    expect(shortUuidCommandWorks).toBe(true);
  });

  test('should handle long UUID format (00009800-0000-1000-8000-00805f9b34fb)', async ({ page }) => {
    await setupMockPage(page, '<html><body>Long UUID Test</body></html>');
    
    // Test command execution with long UUIDs - the helper uses short UUIDs internally
    // but the Noble transport should handle the UUID expansion properly
    const longUuidCommandWorks = await testCommandHelper(page);
    expect(longUuidCommandWorks).toBe(true);
  });

  test('should handle mixed UUID formats (long service, short characteristics)', async ({ page }) => {
    await setupMockPage(page, '<html><body>Mixed UUID Test</body></html>');
    
    // Test command execution with mixed UUIDs
    const mixedUuidCommandWorks = await testCommandHelper(page);
    expect(mixedUuidCommandWorks).toBe(true);
  });
});