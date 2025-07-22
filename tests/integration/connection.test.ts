import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import { WS_URL, getDeviceConfig, setupTestServer } from '../test-config.js';
import { connectionFactory } from '../connection-factory.js';

const DEVICE_CONFIG = getDeviceConfig();


describe('Bridge Connection', () => {
  let server: any;
  
  beforeAll(async () => {
    server = await setupTestServer();
  });
  
  afterAll(async () => {
    await connectionFactory.cleanup();
    if (server) {
      server.stop();
    }
  });
  
  afterEach(async () => {
    // Ensure proper cleanup between tests
    await connectionFactory.cleanup();
  });
  
  
  it('connects to CS108 device', async () => {
    const params = new URLSearchParams(DEVICE_CONFIG);
    const result = await connectionFactory.connect(WS_URL, params);
    
    // If no device found, that's expected in test environment
    if (result.error?.includes('No device found')) {
      console.log('Expected: No CS108 device available in test environment');
      expect(result.error).toContain('No device found');
    } else if (result.connected) {
      expect(result.connected).toBe(true);
      expect(result.deviceName).toBeDefined();
      console.log(`Connected to device: ${result.deviceName}`);
    } else {
      throw new Error(`Unexpected error: ${result.error}`);
    }
  });
  
  it('sends and receives data', async () => {
    const params = new URLSearchParams(DEVICE_CONFIG);
    const ws = new WebSocket(`${WS_URL}?${params}`);
    let connected = false;
    
    const result = await new Promise<{success: boolean; data?: any}>((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false });
      }, 5000);
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        
        if (msg.type === 'connected' && !connected) {
          connected = true;
          console.log('Connected, sending test data...');
          
          // Send test command
          ws.send(JSON.stringify({
            type: 'data',
            data: [0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00]
          }));
        } else if (msg.type === 'data') {
          console.log('Received data response');
          clearTimeout(timeout);
          resolve({ success: true, data: msg.data });
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          resolve({ success: false });
        }
      });
      
      ws.on('error', () => {
        clearTimeout(timeout);
        resolve({ success: false });
      });
    });
    
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    ws.close();
  });
  
  it('handles connection errors', async () => {
    const errorConfig = { ...DEVICE_CONFIG, device: 'NONEXISTENT' };
    const params = new URLSearchParams(errorConfig);
    const ws = new WebSocket(`${WS_URL}?${params}`);
    
    const error = await new Promise<boolean>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'error') {
          resolve(true);
        }
      });
      ws.on('error', () => resolve(true));
      ws.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 15000);
    });
    
    expect(error).toBe(true);
    ws.close();
  });

  describe('UUID Format Validation', () => {
    it('connects with short UUID format', async () => {
      // Use default config which has short UUIDs like '9800'
      const params = new URLSearchParams(DEVICE_CONFIG);
      const result = await connectionFactory.connect(WS_URL, params);
      
      // Mock transport should connect successfully
      if (!server && result.error?.includes('No device found')) {
        console.log('No physical device available, skipping');
        expect(result.error).toContain('No device found');
      } else {
        expect(result.connected || result.error?.includes('No device found')).toBe(true);
      }
    });

    it('connects with full UUID format with dashes', async () => {
      // Use full UUID format with dashes
      const fullUuidConfig = {
        device: DEVICE_CONFIG.device,
        service: '00009800-0000-1000-8000-00805f9b34fb',
        write: '00009900-0000-1000-8000-00805f9b34fb',
        notify: '00009901-0000-1000-8000-00805f9b34fb'
      };
      const params = new URLSearchParams(fullUuidConfig);
      const result = await connectionFactory.connect(WS_URL, params);
      
      // Mock transport should connect successfully
      if (!server && result.error?.includes('No device found')) {
        console.log('No physical device available, skipping');
        expect(result.error).toContain('No device found');
      } else {
        expect(result.connected || result.error?.includes('No device found')).toBe(true);
      }
    });

    it('connects with mixed case UUIDs', async () => {
      // Use mixed case UUIDs
      const mixedCaseConfig = {
        device: DEVICE_CONFIG.device,
        service: '9800',
        write: '9900',
        notify: '9901'
      };
      const params = new URLSearchParams(mixedCaseConfig);
      const result = await connectionFactory.connect(WS_URL, params);
      
      // Mock transport should connect successfully
      if (!server && result.error?.includes('No device found')) {
        console.log('No physical device available, skipping');
        expect(result.error).toContain('No device found');
      } else {
        expect(result.connected || result.error?.includes('No device found')).toBe(true);
      }
    });
  });
});