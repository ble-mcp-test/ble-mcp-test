import { describe, it, expect } from 'vitest';
import { getTestConfig } from '../test-config.js';

describe('Device-agnostic configuration', () => {
  it('requires device configuration from environment', () => {
    // This test will only pass if proper env vars are set
    if (!process.env.BLE_MCP_DEVICE_IDENTIFIER && !process.env.BLE_MCP_DEVICE_NAME && !process.env.BLE_MCP_DEVICE_MAC) {
      expect(() => getTestConfig()).toThrow('BLE device configuration missing');
    } else {
      const config = getTestConfig();
      expect(config.wsUrl).toMatch(/^ws:\/\//);  // Must be a valid WebSocket URL
      expect(config.device).toBeTruthy();  // Must have a device identifier
      expect(config.service).toBeTruthy();  // Must have service UUID
      expect(config.write).toBeTruthy();  // Must have write UUID
      expect(config.notify).toBeTruthy();  // Must have notify UUID
    }
  });

  it('uses BLE_MCP_* environment variables', () => {
    const originalEnv = { ...process.env };
    
    // Clear legacy vars to test new one
    delete process.env.BLE_MCP_DEVICE_NAME;
    delete process.env.BLE_MCP_DEVICE_MAC;
    
    process.env.BLE_MCP_WS_URL = 'ws://custom:9090';
    process.env.BLE_MCP_DEVICE_IDENTIFIER = 'MyDevice';
    process.env.BLE_MCP_SERVICE_UUID = '180f';
    process.env.BLE_MCP_WRITE_UUID = '2a19';
    process.env.BLE_MCP_NOTIFY_UUID = '2a20';
    
    const config = getTestConfig();
    
    expect(config.wsUrl).toBe('ws://custom:9090');
    expect(config.device).toBe('MyDevice');
    expect(config.service).toBe('180f');
    expect(config.write).toBe('2a19');
    expect(config.notify).toBe('2a20');
    
    // Restore original environment
    process.env = originalEnv;
  });
});