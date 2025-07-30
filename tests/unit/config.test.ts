import { describe, it, expect } from 'vitest';
import { getTestConfig } from '../test-config.js';

describe('Device-agnostic configuration', () => {
  it('provides default CS108 configuration', () => {
    const config = getTestConfig();
    // Check that wsUrl is either the default or from env var
    expect(config.wsUrl).toMatch(/^ws:\/\/(localhost|[\d.]+):8080$/);
    // Device should use BLE_DEVICE_PREFIX if set, otherwise platform defaults
    if (process.env.BLE_DEVICE_PREFIX) {
      expect(config.device).toBe(process.env.BLE_DEVICE_PREFIX);
    } else if (process.platform === 'linux') {
      expect(config.device).toBe('6c79b82603a7');
    } else {
      expect(config.device).toBe('CS108');
    }
    expect(config.service).toBe('9800');
    expect(config.write).toBe('9900');
    expect(config.notify).toBe('9901');
  });

  it('allows environment variable overrides', () => {
    const originalEnv = { ...process.env };
    
    process.env.WS_URL = 'ws://custom:9090';
    process.env.BLE_DEVICE_PREFIX = 'MyDevice';
    process.env.BLE_SERVICE_UUID = '180f';
    process.env.BLE_WRITE_UUID = '2a19';
    process.env.BLE_NOTIFY_UUID = '2a20';
    
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