import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import WebSocket from 'ws';

describe('Bridge Connection', () => {
  let server: BridgeServer;
  
  beforeAll(() => {
    server = new BridgeServer();
    server.start(8080);
  });
  
  afterAll(() => {
    server.stop();
  });
  
  it('connects to CS108 device', async () => {
    const ws = new WebSocket('ws://localhost:8080?device=CS108');
    
    const connected = await new Promise((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') {
          resolve(true);
        }
      });
      ws.on('error', () => resolve(false));
    });
    
    expect(connected).toBe(true);
    ws.close();
  });
  
  it('sends and receives data', async () => {
    const ws = new WebSocket('ws://localhost:8080?device=CS108');
    
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
    const ws = new WebSocket('ws://localhost:8080?device=NONEXISTENT');
    
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