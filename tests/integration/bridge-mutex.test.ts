import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import { SharedState } from '../../src/shared-state.js';
import WebSocket from 'ws';
import { WS_URL, getDeviceConfig } from '../test-config.js';

const DEVICE_CONFIG = getDeviceConfig();

/**
 * Simple test to verify the bridge mutex properly rejects concurrent connections
 */
describe('Bridge Mutex Test', () => {
  let server: BridgeServer;
  const port = 8082;
  
  beforeAll(async () => {
    const sharedState = new SharedState(false);
    server = new BridgeServer('info', sharedState);
    await server.start(port);
  });
  
  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('should reject second connection when one is already active', async () => {
    const params = new URLSearchParams(DEVICE_CONFIG);
    const url = `${WS_URL.replace('8080', String(port))}?${params}`;
    
    // First connection
    const ws1 = new WebSocket(url);
    
    // Wait for first connection to be accepted
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('First connection timeout')), 5000);
      
      ws1.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected' || msg.type === 'error') {
          clearTimeout(timeout);
          if (msg.type === 'connected') {
            resolve();
          } else {
            reject(new Error(msg.error));
          }
        }
      });
      
      ws1.on('error', () => {
        clearTimeout(timeout);
        reject(new Error('First connection failed'));
      });
    });
    
    // Now try second connection - should be rejected
    const ws2 = new WebSocket(url);
    
    const rejection = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Second connection timeout')), 2000);
      
      ws2.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        clearTimeout(timeout);
        if (msg.type === 'error') {
          resolve(msg.error);
        } else {
          reject(new Error(`Expected error, got: ${msg.type}`));
        }
      });
      
      ws2.on('error', () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket error'));
      });
    });
    
    // Verify the rejection message
    expect(rejection).toMatch(/Bridge is (connecting|active) - only ready state accepts connections/);
    
    // Clean up
    ws1.close();
    ws2.close();
    
    // Wait for cleanup
    await new Promise(resolve => setTimeout(resolve, 2000));
  });
});