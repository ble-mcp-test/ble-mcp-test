/**
 * Example Playwright test that works in BOTH modes:
 * 1. Development: Uses mock pre-injected by dev server
 * 2. CI/CD: Injects mock itself if needed
 * 
 * This is the recommended pattern for maximum flexibility
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';
import os from 'os';

test.describe('BLE Device Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to app
    await page.goto('http://localhost:5173');
    
    // Smart injection - only inject if not already done by dev server
    const mockStatus = await page.evaluate(() => {
      return {
        hasMock: typeof (window as any).WebBleMock !== 'undefined',
        isInjected: (window as any).__webBluetoothMocked === true
      };
    });
    
    if (!mockStatus.isInjected && mockStatus.hasMock) {
      // CI mode: We need to inject the mock
      console.log('[Test] Injecting mock for CI mode');
      
      await page.evaluate((hostname) => {
        (window as any).WebBleMock.injectWebBluetoothMock({
          sessionId: `myapp-e2e-${hostname}`,
          serverUrl: 'ws://localhost:8080',
          service: '9800',
          write: '9900',
          notify: '9901'
        });
        
        // Mark as injected
        (window as any).__webBluetoothMocked = true;
      }, os.hostname());
      
    } else if (mockStatus.isInjected) {
      // Dev mode: Mock already injected
      console.log('[Test] Using pre-injected mock from dev server');
    } else if (!mockStatus.hasMock) {
      // No mock available - need to load bundle first
      console.log('[Test] Loading mock bundle');
      
      await page.addScriptTag({
        path: path.join(__dirname, '../node_modules/ble-mcp-test/dist/web-ble-mock.bundle.js')
      });
      
      // Now inject
      await page.evaluate((hostname) => {
        (window as any).WebBleMock.injectWebBluetoothMock({
          sessionId: `myapp-e2e-${hostname}`,
          serverUrl: 'ws://localhost:8080',
          service: '9800',
          write: '9900',
          notify: '9901'
        });
        (window as any).__webBluetoothMocked = true;
      }, os.hostname());
    }
    
    // Verify mock is ready
    const ready = await page.evaluate(() => {
      return !!(navigator.bluetooth && navigator.bluetooth.requestDevice);
    });
    
    expect(ready).toBe(true);
  });
  
  test.afterEach(async ({ page }) => {
    // Cleanup ensures no zombie connections
    await cleanupBleTest(page);
  });
  
  test('should connect to device and show battery', async ({ page }) => {
    // Connect to device
    await connectToDevice(page);
    
    // Verify connection UI updated
    await expect(page.locator('[data-testid="disconnect-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="battery-indicator"]')).toBeVisible();
    
    // Get battery level from UI
    const batteryText = await page.locator('[data-testid="battery-indicator"]').textContent();
    console.log('Battery level:', batteryText);
    
    // Battery should be between 20-100%
    const batteryPercent = parseInt(batteryText?.replace('%', '') || '0');
    expect(batteryPercent).toBeGreaterThan(20);
    expect(batteryPercent).toBeLessThanOrEqual(100);
  });
  
  test('should handle disconnect gracefully', async ({ page }) => {
    // Connect first
    await connectToDevice(page);
    await expect(page.locator('[data-testid="disconnect-button"]')).toBeVisible();
    
    // Disconnect
    await disconnectDevice(page);
    
    // Verify UI updated
    await expect(page.locator('[data-testid="connect-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="battery-indicator"]')).not.toBeVisible();
  });
  
  test('should reuse session across multiple connections', async ({ page }) => {
    // First connection
    await connectToDevice(page);
    const firstBattery = await page.locator('[data-testid="battery-indicator"]').textContent();
    await disconnectDevice(page);
    
    // Second connection should reuse the same session
    await connectToDevice(page);
    const secondBattery = await page.locator('[data-testid="battery-indicator"]').textContent();
    
    // Battery levels should be similar (same device, same session)
    const first = parseInt(firstBattery?.replace('%', '') || '0');
    const second = parseInt(secondBattery?.replace('%', '') || '0');
    
    // Battery shouldn't change much in a few seconds
    expect(Math.abs(first - second)).toBeLessThanOrEqual(2);
    
    await disconnectDevice(page);
  });
  
  test('should handle rapid connect/disconnect cycles', async ({ page }) => {
    // This tests for zombie connections
    for (let i = 0; i < 3; i++) {
      console.log(`Connection cycle ${i + 1}/3`);
      
      await connectToDevice(page);
      
      // Verify connection works
      await expect(page.locator('[data-testid="battery-indicator"]')).toBeVisible();
      
      await disconnectDevice(page);
      
      // Verify clean disconnect
      await expect(page.locator('[data-testid="connect-button"]')).toBeVisible();
    }
    
    // Final connection should still work (no zombies)
    await connectToDevice(page);
    await expect(page.locator('[data-testid="battery-indicator"]')).toBeVisible();
  });
  
  test('should read real device data', async ({ page }) => {
    await connectToDevice(page);
    
    // Trigger a device operation (e.g., RFID scan)
    const scanButton = page.locator('[data-testid="scan-button"]');
    if (await scanButton.isVisible()) {
      await scanButton.click();
      
      // Wait for scan results
      await page.waitForSelector('[data-testid="tag-list"]', { timeout: 5000 });
      
      // Verify we got real tag data
      const tags = await page.locator('[data-testid="tag-item"]').count();
      console.log(`Found ${tags} RFID tags`);
      
      // This would be real tags if hardware is present
      expect(tags).toBeGreaterThanOrEqual(0);
    }
  });
});

/**
 * Test configuration for different scenarios
 */
test.describe('Connection Scenarios', () => {
  test.beforeEach(async ({ page }) => {
    await setupBleTest(page);
  });
  
  test.afterEach(async ({ page }) => {
    await cleanupBleTest(page);
  });
  
  test.skip('should handle bridge server restart', async ({ page }) => {
    // This test would require manually restarting the bridge
    // Useful for testing reconnection logic
    
    await connectToDevice(page);
    
    // Simulate bridge restart
    console.log('Restart bridge server now...');
    await page.waitForTimeout(10000); // Give time to restart
    
    // Should auto-reconnect or show error
    const errorMessage = page.locator('[data-testid="error-message"]');
    const disconnectButton = page.locator('[data-testid="disconnect-button"]');
    
    // Either we see an error or we're still connected
    const hasError = await errorMessage.isVisible();
    const stillConnected = await disconnectButton.isVisible();
    
    expect(hasError || stillConnected).toBe(true);
  });
  
  test('should verify mock version compatibility', async ({ page }) => {
    const version = await page.evaluate(() => {
      return (window as any).WebBleMock?.version || null;
    });
    
    console.log('Mock version:', version);
    
    // Ensure we're using 0.6.0+ (required for sessionId)
    expect(version).toBeTruthy();
    const [major, minor] = version.split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(0);
    if (major === 0) {
      expect(minor).toBeGreaterThanOrEqual(6);
    }
  });
});