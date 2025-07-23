import { describe, it, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import WebSocket from 'ws';
import { WS_URL, getDeviceConfig } from '../test-config.js';

const DEVICE_CONFIG = getDeviceConfig();

describe('Parallel Connection Pressure Test', () => {
  let server: BridgeServer;
  
  beforeAll(() => {
    // Always use local server for this test
    server = new BridgeServer('debug'); // Force debug logging
    server.start(8080);
  });
  
  afterAll(() => {
    if (server) {
      server.stop();
    }
  });
  
  it('simulates misconfigured parallel tests causing resource pressure', async () => {
    console.log('\n⚡ PARALLEL PRESSURE TEST\n');
    console.log('Simulating what happens when tests run in parallel (misconfigured)...\n');
    
    // Keep connections alive to build up pressure
    const activeConnections: WebSocket[] = [];
    
    // Phase 1: Create multiple overlapping connection attempts
    console.log('Phase 1: Creating overlapping connections...\n');
    
    for (let i = 0; i < 5; i++) {
      const params = new URLSearchParams(DEVICE_CONFIG);
      const ws = new WebSocket(`${WS_URL}?${params}`);
      activeConnections.push(ws);
      
      // Set up handlers but don't wait for connection
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') {
          console.log(`   Connection ${i + 1}: Connected to ${msg.device}`);
        } else if (msg.type === 'error' && msg.error.includes('Another connection')) {
          console.log(`   Connection ${i + 1}: Rejected (another connection active) ✓`);
        }
      });
      
      ws.on('error', () => {
        console.log(`   Connection ${i + 1}: WebSocket error`);
      });
      
      // Small delay between attempts
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Wait for connections to settle
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Phase 2: Disconnect the successful connection to trigger cooldown
    console.log('\nPhase 2: Disconnecting to observe pressure-adjusted cooldown...\n');
    
    // Close all connections
    activeConnections.forEach((ws, i) => {
      if (ws.readyState === WebSocket.OPEN) {
        console.log(`   Closing connection ${i + 1}`);
        ws.close();
      }
    });
    
    // Wait for disconnects
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Phase 3: Try rapid reconnections to build more pressure
    console.log('\nPhase 3: Rapid reconnection attempts...\n');
    
    const rapidAttempts = 10;
    for (let i = 0; i < rapidAttempts; i++) {
      const params = new URLSearchParams(DEVICE_CONFIG);
      const ws = new WebSocket(`${WS_URL}?${params}`);
      
      // Don't wait, just fire and forget to create pressure
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') {
          console.log(`   Rapid attempt ${i + 1}: Connected!`);
          // Immediately disconnect to create churn
          setTimeout(() => ws.close(), 50);
        }
      });
      
      ws.on('error', () => {}); // Ignore errors
      
      // Minimal delay
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    
    // Wait for the storm to pass
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Phase 4: Final connection to see maximum cooldown
    console.log('\nPhase 4: Final connection after pressure buildup...\n');
    
    const finalParams = new URLSearchParams(DEVICE_CONFIG);
    const finalWs = new WebSocket(`${WS_URL}?${finalParams}`);
    
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.log('   Final connection timed out');
        finalWs.close();
        resolve();
      }, 5000);
      
      finalWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') {
          console.log(`   ✅ Final connection successful to ${msg.device}`);
          clearTimeout(timeout);
          finalWs.close();
          resolve();
        } else if (msg.type === 'error') {
          console.log(`   ❌ Final connection failed: ${msg.error}`);
          clearTimeout(timeout);
          resolve();
        }
      });
      
      finalWs.on('error', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    
    console.log('\n✅ Parallel pressure test complete!');
    console.log('   Review logs above to see how cooldown scaled with pressure');
  });
});