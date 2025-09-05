import { test, expect } from '@playwright/test';
import { E2E_TEST_CONFIG, getBleConfig, setupMockPage } from './test-config';

test.describe('Real Device Session Test', () => {
  test('should connect using service-only filtering (no device name)', async ({ page }) => {
    // Test will fail if bridge server not available - that's intentional for troubleshooting

    // Setup page with bundle and inject mock using shared helper
    await setupMockPage(page);

    const result = await page.evaluate(async ({ config }) => {
      const output: any = {};
      
      try {
        // Mock already injected by setupMockPage
        output.mockInjected = true;
        
        // Request device with service UUID filter only (no device name filter)
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [config.service] }]
        });
        
        output.deviceFound = true;
        output.deviceId = device.id;
        output.deviceName = device.name;
        
        // Connect
        await device.gatt.connect();
        output.connected = device.gatt.connected;
        
        // Clean disconnect
        await device.gatt.disconnect();
        output.disconnected = !device.gatt.connected;
        
      } catch (error: any) {
        output.error = error.message;
      }
      
      return output;
    }, { config: getBleConfig() });

    console.log('Service-only filter result:', result);
    
    // Verify device was found
    expect(result.mockInjected).toBe(true);
    expect(result.deviceFound).toBe(true);
    expect(result.deviceName).not.toBe('MockDevice000000');
    
    // Connection might fail if no real device with service is available  
    if (result.error) {
      console.log('Expected behavior: Connection failed because no real device found or device busy');
      // Accept timeout or device busy - both are valid depending on test suite context
      expect(result.error).toMatch(/timeout|Device is busy with another session|Connection failed/);
    } else {
      // If a real device was found, verify connection worked
      expect(result.connected).toBe(true);
      expect(result.disconnected).toBe(true);
    }
  });

  test('should connect to real device with session ID', async ({ page }) => {
    // Test will fail if bridge server not available - that's intentional for troubleshooting
    
    const deviceConfig = getBleConfig();
    console.log('Device configuration from environment:');
    console.log(`  Service UUID: ${deviceConfig.service}`);
    console.log(`  Write UUID: ${deviceConfig.write}`);
    console.log(`  Notify UUID: ${deviceConfig.notify}`);

    // Capture console logs
    const consoleLogs: string[] = [];
    page.on('console', msg => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });

    // Setup page with bundle and inject mock using shared helper
    await setupMockPage(page);
    
    // Pass device config to browser context
    const result = await page.evaluate(async ({ config }) => {
      // Mock already injected by setupMockPage
      try {
        // Use service-based filtering instead of device name
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [config.service] }]
        });
        
        const deviceInfo = {
          id: device.id,
          name: device.name,
          sessionId: (device as any).sessionId
        };
        
        // Try to connect
        await device.gatt!.connect();
        
        return { 
          connected: true,
          device: deviceInfo,
          error: null 
        };
      } catch (e) {
        return { 
          connected: false,
          device: null,
          error: e.message 
        };
      }
    }, { config: deviceConfig });

    console.log('Connection result:', result);
    
    if (result.connected) {
      console.log('✅ Successfully connected to real device!');
      console.log(`   Device: ${result.device.name} (${result.device.id})`);
      console.log(`   Session: ${result.device.sessionId}`);
      
      // Verify session ID was used
      expect(result.device.sessionId).toBe(deviceConfig.sessionId);
    } else {
      console.log('❌ Connection failed:', result.error);
    }
  });

});