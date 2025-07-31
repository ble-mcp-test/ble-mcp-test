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
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const sharedState = new SharedState(false);
    server = new BridgeServer('info', sharedState);
    await server.start(port);
  });
  
  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  it.skip('should reject connections while busy, then accept after recovery', async () => {
    const params = new URLSearchParams(DEVICE_CONFIG);
    const url = `${WS_URL.replace('8080', String(port))}?${params}`;
    
    console.log('\n🔒 Testing mutex and recovery behavior\n');
    
    // First connection
    const ws1 = new WebSocket(url);
    
    // Wait for first connection to be accepted
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('First connection timeout')), 3000);
      
      ws1.on('open', () => {
        clearTimeout(timeout);
        console.log('  ✅ First connection accepted');
        resolve();
      });
      
      ws1.on('error', () => {
        clearTimeout(timeout);
        reject(new Error('First WebSocket connection failed'));
      });
    });
    
    // Start firing connection attempts every 100ms
    let rejectionCount = 0;
    let acceptedConnection: WebSocket | null = null;
    const attemptConnections = true;
    let closeTime = 0;
    
    const connectionLoop = setInterval(() => {
      if (!attemptConnections) return;
      
      const ws = new WebSocket(url);
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'error' && msg.error.includes('only ready state accepts connections')) {
          rejectionCount++;
          if (rejectionCount % 10 === 1) { // Log every 10th rejection to reduce noise
            console.log(`  ❌ Connection rejected (#${rejectionCount}): ${msg.error}`);
          }
          ws.close();
        } else if (msg.type === 'connected') {
          const recoveryTime = Date.now() - closeTime;
          console.log(`  ✅ New connection accepted after recovery! (${recoveryTime}ms after close)`);
          acceptedConnection = ws;
          clearInterval(connectionLoop);
        } else if (msg.type === 'error' && msg.error.includes('disconnecting')) {
          // Bridge is in recovery period
          if (!ws1.readyState || ws1.readyState === WebSocket.CLOSED) {
            console.log('  🔄 Bridge is in recovery period...');
          }
          ws.close();
        }
      });
      
      ws.on('error', () => {
        // Ignore connection errors
      });
    }, 100);
    
    // After 1 second, close the first connection to trigger recovery
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log('\n  🔄 Closing first connection to trigger recovery...\n');
    closeTime = Date.now();
    ws1.close();
    
    // Wait up to 15 seconds for a new connection to be accepted
    // Bridge has a recovery period after disconnection (default 1s for clean disconnect)
    // Under stress conditions, recovery can take longer (observed up to 13 seconds)
    const startTime = Date.now();
    while (!acceptedConnection && Date.now() - startTime < 15000) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Stop the connection loop
    clearInterval(connectionLoop);
    
    // Verify results
    expect(rejectionCount).toBeGreaterThan(5); // Should have rejected many connections
    expect(acceptedConnection).not.toBeNull(); // Should have accepted a new connection
    
    console.log(`\n  📊 Test complete: ${rejectionCount} rejections, then recovery succeeded\n`);
    
    // Clean up
    if (acceptedConnection) {
      acceptedConnection.close();
    }
    
    // Wait for cleanup
    await new Promise(resolve => setTimeout(resolve, 1000));
  }, 30000);
});