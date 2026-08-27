import { test, expect } from '@playwright/test';
import { setupMockPage, getBleConfig, injectMockInPage } from './test-config';

test.describe('UUID Format Compatibility', () => {
  test('should handle short UUID format (9800)', async ({ page }) => {
    await setupMockPage(page, '<html><body>Short UUID Test</body></html>');
    
    // Override config to use short UUID format
    const shortUuidConfig = {
      ...getBleConfig(),
      service: '9800',      // Short format
      write: '9900',        // Short format
      notify: '9901'        // Short format
    };
    
    // Test command execution with short UUIDs
    const result = await page.evaluate(async ({ config }) => {
      try {
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [config.service] }]
        });
        
        await device.gatt.connect();
        const service = await device.gatt.getPrimaryService(config.service);
        const writeChar = await service.getCharacteristic(config.write);
        const notifyChar = await service.getCharacteristic(config.notify);
        
        // Verify we got the characteristics with short UUIDs
        return {
          success: true,
          serviceUuid: service.uuid,
          writeUuid: writeChar.uuid,
          notifyUuid: notifyChar.uuid
        };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }, { config: shortUuidConfig });
    
    expect(result.success).toBe(true);
    console.log('[TEST] Short UUID test passed:', result);
  });

  test('should handle long UUID format (00009800-0000-1000-8000-00805f9b34fb)', async ({ page }) => {
    await setupMockPage(page, '<html><body>Long UUID Test</body></html>');
    
    // Override config to use long UUID format  
    const longUuidConfig = {
      ...getBleConfig(),
      service: '00009800-0000-1000-8000-00805f9b34fb',   // Long format
      write: '00009900-0000-1000-8000-00805f9b34fb',     // Long format
      notify: '00009901-0000-1000-8000-00805f9b34fb'     // Long format
    };
    
    // Re-inject mock with long UUID config
    await injectMockInPage(page, longUuidConfig);
    
    // Test command execution with long UUIDs
    const result = await page.evaluate(async ({ config }) => {
      try {
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [config.service] }]
        });
        
        await device.gatt.connect();
        const service = await device.gatt.getPrimaryService(config.service);
        const writeChar = await service.getCharacteristic(config.write);
        const notifyChar = await service.getCharacteristic(config.notify);
        
        // Verify we got the characteristics with long UUIDs
        return {
          success: true,
          serviceUuid: service.uuid,
          writeUuid: writeChar.uuid,
          notifyUuid: notifyChar.uuid
        };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }, { config: longUuidConfig });
    
    expect(result.success).toBe(true);
    console.log('[TEST] Long UUID test passed:', result);
  });

  test('should handle mixed UUID formats (long service, short characteristics)', async ({ page }) => {
    await setupMockPage(page, '<html><body>Mixed UUID Test</body></html>');
    
    // Override config to use mixed UUID formats
    const mixedUuidConfig = {
      ...getBleConfig(),
      service: '00009800-0000-1000-8000-00805f9b34fb',   // Long format
      write: '9900',                                      // Short format
      notify: '9901'                                      // Short format
    };
    
    // Re-inject mock with mixed UUID config
    await injectMockInPage(page, mixedUuidConfig);
    
    // Test command execution with mixed UUIDs
    const result = await page.evaluate(async ({ config }) => {
      try {
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [config.service] }]
        });
        
        await device.gatt.connect();
        const service = await device.gatt.getPrimaryService(config.service);
        const writeChar = await service.getCharacteristic(config.write);
        const notifyChar = await service.getCharacteristic(config.notify);
        
        // Verify we got the characteristics with mixed UUIDs
        return {
          success: true,
          serviceUuid: service.uuid,
          writeUuid: writeChar.uuid,
          notifyUuid: notifyChar.uuid
        };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }, { config: mixedUuidConfig });
    
    expect(result.success).toBe(true);
    console.log('[TEST] Mixed UUID test passed:', result);
  });
});