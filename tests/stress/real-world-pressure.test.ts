import { describe, it, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import WebSocket from 'ws';
import { WS_URL, getDeviceConfig } from '../test-config.js';

const DEVICE_CONFIG = getDeviceConfig();

describe('Real-World Pressure Test', () => {
  let server: BridgeServer;
  
  beforeAll(() => {
    server = new BridgeServer('debug');
    server.start(8080);
  });
  
  afterAll(() => {
    if (server) {
      server.stop();
    }
  });
  
  it('simulates real-world test runner behavior with sequential connections', async () => {
    console.log('\n🌍 REAL-WORLD PRESSURE TEST\n');
    console.log('Simulating a test runner executing multiple tests sequentially...\n');
    
    const testCount = 30;
    const testDelay = 100; // Minimal delay between tests
    
    for (let i = 0; i < testCount; i++) {
      console.log(`\n📋 Test ${i + 1}/${testCount}:`);
      
      const params = new URLSearchParams(DEVICE_CONFIG);
      const ws = new WebSocket(`${WS_URL}?${params}`);
      
      try {
        // Wait for connection
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Connection timeout'));
          }, 5000);
          
          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'connected') {
              clearTimeout(timeout);
              console.log(`   ✅ Connected to ${msg.device}`);
              resolve();
            } else if (msg.type === 'error') {
              clearTimeout(timeout);
              reject(new Error(msg.error));
            }
          });
          
          ws.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
        
        // Simulate some test activity
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Disconnect
        console.log('   🔌 Disconnecting...');
        ws.close();
        
        // Wait for disconnect to complete
        await new Promise(resolve => setTimeout(resolve, testDelay));
        
      } catch (error: any) {
        console.log(`   ❌ Test failed: ${error.message}`);
        ws.close();
        // Continue to next test even on failure
      }
      
      // Show pressure buildup every 5 tests
      if ((i + 1) % 5 === 0) {
        console.log(`\n📊 Pressure check after ${i + 1} tests - watch the logs above!`);
      }
    }
    
    console.log('\n🏁 Real-world pressure test complete!');
    console.log('   Review the logs to see how pressure builds over sequential tests.');
  });
});