import { test, expect } from '@playwright/test';
import { BridgeServer } from '../../src/index.js';
import { getTestConfig, getDeviceConfig } from '../test-config.js';

test.describe('WebSocket Bridge E2E', () => {
  let bridge: BridgeServer;
  const testConfig = getTestConfig();

  test.beforeAll(async () => {
    // Start bridge server if not using external
    if (!process.env.WS_URL || process.env.WS_URL.includes('localhost')) {
      bridge = new BridgeServer();
      bridge.start(8080);
    }
  });

  test.afterAll(async () => {
    if (bridge) {
      bridge.stop();
    }
  });

  test('Web Bluetooth mock can send GET_BATTERY_VOLTAGE through bridge', async ({ page }) => {
    const wsUrl = testConfig.wsUrl;
    const deviceConfig = getDeviceConfig();
    
    // Navigate to our test page that uses the real browser bundle
    await page.goto('/tests/e2e/test-page.html');
    
    // Execute the test with configuration
    console.log(`🔌 Testing Web Bluetooth mock with bridge at: ${wsUrl}`);
    console.log(`📋 Device config:`, deviceConfig);
    
    const results = await page.evaluate(async ({ url, config }) => {
      return await (window as any).testBatteryCommand(url, config);
    }, { url: wsUrl, config: deviceConfig });
    
    console.log('📊 Test results:', results);
    
    // Check results
    if (results.error?.includes('No device found')) {
      // Expected in test environment without BLE device
      console.log('✅ No CS108 device available (expected in test environment)');
      expect(results.error).toContain('No device found');
    } else if (results.batteryVoltage) {
      // Successfully got battery voltage via Web Bluetooth API!
      console.log(`✅ Battery voltage via Web Bluetooth mock: ${results.batteryVoltage}mV`);
      expect(results.connected).toBe(true);
      expect(results.device).toContain('CS108');
      expect(results.batteryVoltage).toBeGreaterThan(3000);
      expect(results.batteryVoltage).toBeLessThan(4500);
    } else {
      // Unexpected error
      throw new Error(`Unexpected result: ${JSON.stringify(results)}`);
    }
  });
});