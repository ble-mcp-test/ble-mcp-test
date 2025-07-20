import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import WebSocket from 'ws';

const WS_URL = process.env.WS_URL || 'ws://localhost:8080';

describe('Bridge Connection', () => {
  let server: BridgeServer;
  let useExternalServer = false;
  
  beforeAll(() => {
    // If WS_URL is set and not localhost, use external server
    if (process.env.WS_URL && !process.env.WS_URL.includes('localhost')) {
      useExternalServer = true;
      console.log(`Using external WebSocket server at: ${WS_URL}`);
    } else {
      // Start local server for testing
      server = new BridgeServer();
      server.start(8080);
    }
  });
  
  afterAll(() => {
    if (!useExternalServer && server) {
      server.stop();
    }
  });
  
  it('connects to CS108 device', async () => {
    const ws = new WebSocket(`${WS_URL}?device=CS108`);
    
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
    const ws = new WebSocket(`${WS_URL}?device=CS108`);
    
    // Wait for connection
    await new Promise((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') resolve(true);
      });
    });
    
    // Send test command
    ws.send(JSON.stringify({
      type: 'data',
      data: [0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x02]
    }));
    
    // Should receive response
    const response = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'data') resolve(msg);
      });
      setTimeout(() => resolve(null), 5000); // 5s timeout
    });
    
    expect(response).toHaveProperty('data');
    ws.close();
  });
  
  it('handles connection errors', async () => {
    const ws = new WebSocket(`${WS_URL}?device=NONEXISTENT`);
    
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
});