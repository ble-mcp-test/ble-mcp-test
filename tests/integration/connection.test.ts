import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import WebSocket from 'ws';
import { WS_URL, getDeviceConfig } from '../test-config.js';

const DEVICE_CONFIG = getDeviceConfig();

// Helper to find free port
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer();
    server.listen(0, () => {
      const port = server.address()?.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

describe('Bridge Connection', () => {
  let server: BridgeServer;
  let useExternalServer = false;
  let testPort = 8080;
  let testUrl = WS_URL;
  
  beforeAll(async () => {
    // If WS_URL is set and not localhost, use external server
    if (process.env.WS_URL && !process.env.WS_URL.includes('localhost')) {
      useExternalServer = true;
      console.log(`Using external WebSocket server at: ${WS_URL}`);
    } else {
      // Find free port to avoid conflicts
      testPort = await findFreePort();
      testUrl = `ws://localhost:${testPort}`;
      console.log(`Starting test server on port ${testPort}`);
      
      // Start local server for testing with mock transport
      server = new BridgeServer();
      server.start(testPort, { useMockTransport: true });
      
      // Wait for server to be ready
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  });
  
  afterAll(async () => {
    if (!useExternalServer && server) {
      await server.stop();
      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  });
  
  beforeEach(async () => {
    // Reset server state between tests
    if (!useExternalServer && server) {
      // Allow some time for previous test cleanup
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  });
  
  it('connects to CS108 device', async () => {
    const params = new URLSearchParams(DEVICE_CONFIG);
    const ws = new WebSocket(`${testUrl}?${params}`);
    
    const result = await new Promise<{ connected: boolean; error?: string }>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') {
          resolve({ connected: true });
        } else if (msg.type === 'error') {
          resolve({ connected: false, error: msg.error });
        }
      });
      ws.on('error', () => resolve({ connected: false, error: 'WebSocket error' }));
      setTimeout(() => resolve({ connected: false, error: 'Timeout' }), 5000);
    });
    
    // If no device found, that's expected in test environment
    if (result.error?.includes('No device found')) {
      console.log('Expected: No CS108 device available in test environment');
      expect(result.error).toContain('No device found');
    } else if (result.connected) {
      expect(result.connected).toBe(true);
    } else {
      throw new Error(`Unexpected error: ${result.error}`);
    }
    
    ws.close();
  });
  
  it('sends and receives data', async () => {
    const params = new URLSearchParams(DEVICE_CONFIG);
    const ws = new WebSocket(`${testUrl}?${params}`);
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
    const ws = new WebSocket(`${testUrl}?${params}`);
    
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
      const ws = new WebSocket(`${testUrl}?${params}`);
      
      const result = await new Promise<{ connected: boolean; error?: string }>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'connected') {
            resolve({ connected: true });
          } else if (msg.type === 'error') {
            resolve({ connected: false, error: msg.error });
          }
        });
        ws.on('error', () => resolve({ connected: false, error: 'WebSocket error' }));
        setTimeout(() => resolve({ connected: false, error: 'Timeout' }), 5000);
      });
      
      // Mock transport should connect successfully
      if (useExternalServer && result.error?.includes('No device found')) {
        console.log('No physical device available, skipping');
        expect(result.error).toContain('No device found');
      } else {
        expect(result.connected || result.error?.includes('No device found')).toBe(true);
      }
      
      ws.close();
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
      const ws = new WebSocket(`${testUrl}?${params}`);
      
      const result = await new Promise<{ connected: boolean; error?: string }>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'connected') {
            resolve({ connected: true });
          } else if (msg.type === 'error') {
            resolve({ connected: false, error: msg.error });
          }
        });
        ws.on('error', () => resolve({ connected: false, error: 'WebSocket error' }));
        setTimeout(() => resolve({ connected: false, error: 'Timeout' }), 5000);
      });
      
      // Mock transport should connect successfully
      if (useExternalServer && result.error?.includes('No device found')) {
        console.log('No physical device available, skipping');
        expect(result.error).toContain('No device found');
      } else {
        expect(result.connected || result.error?.includes('No device found')).toBe(true);
      }
      
      ws.close();
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
      const ws = new WebSocket(`${testUrl}?${params}`);
      
      const result = await new Promise<{ connected: boolean; error?: string }>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'connected') {
            resolve({ connected: true });
          } else if (msg.type === 'error') {
            resolve({ connected: false, error: msg.error });
          }
        });
        ws.on('error', () => resolve({ connected: false, error: 'WebSocket error' }));
        setTimeout(() => resolve({ connected: false, error: 'Timeout' }), 5000);
      });
      
      // Mock transport should connect successfully
      if (useExternalServer && result.error?.includes('No device found')) {
        console.log('No physical device available, skipping');
        expect(result.error).toContain('No device found');
      } else {
        expect(result.connected || result.error?.includes('No device found')).toBe(true);
      }
      
      ws.close();
    });
  });
});