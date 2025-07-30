import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { BridgeServer } from '../../src/bridge-server.js';

describe('Force Cleanup with Token Validation Tests', () => {
  let server: BridgeServer;
  let wsUrl: string;
  
  beforeAll(async () => {
    server = new BridgeServer('info');
    await server.start(0);
    const address = server['wss']?.address();
    const port = typeof address === 'object' ? address.port : 8080;
    wsUrl = `ws://localhost:${port}`;
  });
  
  afterAll(async () => {
    await server.stop();
  });
  
  it('should include token in connected message', async () => {
    const params = new URLSearchParams({
      device: 'TestDevice',
      service: '180f',
      write: '2a19',
      notify: '2a19'
    });
    
    const ws = new WebSocket(`${wsUrl}?${params}`);
    
    const connectedMsg = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected' || msg.type === 'error') {
          clearTimeout(timeout);
          if (msg.type === 'error' && msg.error.includes('No device found')) {
            ws.close();
            resolve({ type: 'error', error: 'No device found' });
          } else {
            resolve(msg);
          }
        }
      });
      
      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    
    if (connectedMsg.type === 'error') {
      console.log('Skipping token test: No device available');
      return;
    }
    
    // Should have received a token
    expect(connectedMsg.type).toBe('connected');
    expect(connectedMsg.token).toBeDefined();
    expect(connectedMsg.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(connectedMsg.device).toBeDefined();
    
    ws.close();
  });
  
  it('should accept force_cleanup with valid token', async () => {
    const params = new URLSearchParams({
      device: 'TestDevice',
      service: '180f',
      write: '2a19',
      notify: '2a19'
    });
    
    const ws = new WebSocket(`${wsUrl}?${params}`);
    let connectionToken: string | undefined;
    
    // Wait for connection and get token
    const connected = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 10000);
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') {
          clearTimeout(timeout);
          connectionToken = msg.token;
          resolve(true);
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          resolve(false);
        }
      });
    });
    
    if (!connected || !connectionToken) {
      console.log('Skipping force cleanup test: No device available');
      ws.close();
      return;
    }
    
    // Send force_cleanup with valid token
    ws.send(JSON.stringify({
      type: 'force_cleanup',
      token: connectionToken
    }));
    
    // Should receive force_cleanup_complete
    const response = await new Promise<any>((resolve) => {
      const timeout = setTimeout(() => resolve({ type: 'timeout' }), 5000);
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'force_cleanup_complete' || msg.type === 'error') {
          clearTimeout(timeout);
          resolve(msg);
        }
      });
    });
    
    expect(response.type).toBe('force_cleanup_complete');
    expect(response.message).toContain('cleanup completed successfully');
    
    // Connection should close after cleanup
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
  
  it('should reject force_cleanup with invalid token', async () => {
    const params = new URLSearchParams({
      device: 'TestDevice',
      service: '180f',
      write: '2a19',
      notify: '2a19'
    });
    
    const ws = new WebSocket(`${wsUrl}?${params}`);
    
    // Wait for connection
    const connected = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 10000);
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') {
          clearTimeout(timeout);
          resolve(true);
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          resolve(false);
        }
      });
    });
    
    if (!connected) {
      console.log('Skipping invalid token test: No device available');
      ws.close();
      return;
    }
    
    // Send force_cleanup with invalid token
    ws.send(JSON.stringify({
      type: 'force_cleanup',
      token: 'invalid-token-123'
    }));
    
    // Should receive error
    const response = await new Promise<any>((resolve) => {
      const timeout = setTimeout(() => resolve({ type: 'timeout' }), 5000);
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'error' || msg.type === 'force_cleanup_complete') {
          clearTimeout(timeout);
          resolve(msg);
        }
      });
    });
    
    expect(response.type).toBe('error');
    expect(response.error).toContain('Invalid token');
    
    // Connection should still be open
    expect(ws.readyState).toBe(WebSocket.OPEN);
    
    ws.close();
  });
  
  it('should reject force_cleanup without token', async () => {
    const params = new URLSearchParams({
      device: 'TestDevice',
      service: '180f',
      write: '2a19',
      notify: '2a19'
    });
    
    const ws = new WebSocket(`${wsUrl}?${params}`);
    
    // Wait for connection
    const connected = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 10000);
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') {
          clearTimeout(timeout);
          resolve(true);
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          resolve(false);
        }
      });
    });
    
    if (!connected) {
      console.log('Skipping no token test: No device available');
      ws.close();
      return;
    }
    
    // Send force_cleanup without token
    ws.send(JSON.stringify({
      type: 'force_cleanup'
    }));
    
    // Should receive error
    const response = await new Promise<any>((resolve) => {
      const timeout = setTimeout(() => resolve({ type: 'timeout' }), 5000);
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'error' || msg.type === 'force_cleanup_complete') {
          clearTimeout(timeout);
          resolve(msg);
        }
      });
    });
    
    expect(response.type).toBe('error');
    expect(response.error).toContain('Invalid token');
    
    ws.close();
  });
  
  it('should block new connections during force cleanup', async () => {
    const params = new URLSearchParams({
      device: 'TestDevice',
      service: '180f',
      write: '2a19',
      notify: '2a19'
    });
    
    // First connection
    const ws1 = new WebSocket(`${wsUrl}?${params}`);
    let connectionToken: string | undefined;
    
    // Wait for first connection and get token
    const connected = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 10000);
      
      ws1.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') {
          clearTimeout(timeout);
          connectionToken = msg.token;
          resolve(true);
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          resolve(false);
        }
      });
    });
    
    if (!connected || !connectionToken) {
      console.log('Skipping cleanup blocking test: No device available');
      ws1.close();
      return;
    }
    
    // Start force cleanup
    ws1.send(JSON.stringify({
      type: 'force_cleanup',
      token: connectionToken
    }));
    
    // Immediately try to connect with second client
    const ws2 = new WebSocket(`${wsUrl}?${params}`);
    
    // Second connection should be rejected
    const response = await new Promise<any>((resolve) => {
      const timeout = setTimeout(() => resolve({ type: 'timeout' }), 5000);
      
      ws2.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'error' || msg.type === 'connected') {
          clearTimeout(timeout);
          resolve(msg);
        }
      });
    });
    
    expect(response.type).toBe('error');
    expect(response.error).toMatch(/cleanup in progress|Another connection is active/);
    
    // Cleanup
    ws1.close();
    ws2.close();
    
    // Wait for cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 2000));
  });
});