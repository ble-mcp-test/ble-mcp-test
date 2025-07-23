import { describe, it, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import WebSocket from 'ws';
import { WS_URL, getDeviceConfig } from '../test-config.js';

const DEVICE_CONFIG = getDeviceConfig();

describe('Listener Pressure Test', () => {
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
  
  it('demonstrates dynamic cooldown scaling under listener pressure', async () => {
    console.log('\n🔥 LISTENER PRESSURE TEST - Watch cooldown scale dynamically!\n');
    
    // Create multiple concurrent connections to build pressure
    const connections: WebSocket[] = [];
    const connectionAttempts = 20;
    
    // First, create many rapid connections without cleanup
    console.log('Creating rapid connections to build listener pressure...\n');
    
    for (let i = 0; i < connectionAttempts; i++) {
      const params = new URLSearchParams(DEVICE_CONFIG);
      const ws = new WebSocket(`${WS_URL}?${params}`);
      connections.push(ws);
      
      // Don't wait for responses, just fire connections rapidly
      ws.on('error', () => {}); // Ignore errors
      
      // Minimal delay to create pressure
      await new Promise(resolve => setTimeout(resolve, 50));
      
      if (i % 5 === 4) {
        console.log(`📊 Created ${i + 1} connection attempts...`);
      }
    }
    
    // Now create one more connection to see the accumulated pressure
    console.log('\n🎯 Final connection to observe maximum cooldown:');
    const finalParams = new URLSearchParams(DEVICE_CONFIG);
    const finalWs = new WebSocket(`${WS_URL}?${finalParams}`);
    
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        finalWs.close();
        resolve();
      }, 2000);
      
      finalWs.on('message', () => {
        finalWs.close();
        resolve();
      });
      
      finalWs.on('error', () => resolve());
    });
    
    // Cleanup
    console.log('\n🧹 Cleaning up connections...');
    connections.forEach(ws => ws.close());
    
    console.log('\n✅ Pressure test complete - check logs above for cooldown scaling!');
  });
});