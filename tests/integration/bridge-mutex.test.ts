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
  const port = 8087; // Use different port to avoid conflicts
  
  beforeAll(async () => {
    // Give device time to recover from previous tests
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const sharedState = new SharedState(false);
    server = new BridgeServer('info', sharedState);
    await server.start(port);
  });
  
  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('should reject second connection when one is already active or connecting', async () => {
    const params = new URLSearchParams(DEVICE_CONFIG);
    const url = `${WS_URL.replace('8080', String(port))}?${params}`;
    
    // First connection
    const ws1 = new WebSocket(url);
    
    // Wait for first connection to be accepted by the bridge
    // The bridge should immediately transition from 'ready' to 'connecting'
    let firstConnectionAccepted = false;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('First connection was not accepted by bridge'));
      }, 2000);
      
      ws1.on('open', () => {
        // WebSocket is open, bridge has accepted the connection
        firstConnectionAccepted = true;
        clearTimeout(timeout);
        resolve();
      });
      
      ws1.on('error', () => {
        clearTimeout(timeout);
        reject(new Error('First WebSocket connection failed'));
      });
    });
    
    if (!firstConnectionAccepted) {
      throw new Error('Bridge did not accept first connection');
    }
    
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