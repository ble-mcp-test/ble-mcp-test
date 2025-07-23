import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import WebSocket from 'ws';
import { WS_URL, getDeviceConfig } from '../test-config.js';

const DEVICE_CONFIG = getDeviceConfig();

describe('Dynamic Cooldown Scaling Test', () => {
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
  
  it('demonstrates cooldown scaling with rapid connect/disconnect cycles', async () => {
    console.log('\n🔥 DYNAMIC COOLDOWN SCALING TEST\n');
    console.log('Watch how disconnect cooldown increases as listener pressure builds!\n');
    
    const cycles = 10;
    
    for (let i = 0; i < cycles; i++) {
      console.log(`\n📊 Connection cycle ${i + 1}/${cycles}:`);
      
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
              console.log(`✅ Connected to ${msg.device}`);
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
        
        // Immediately disconnect to trigger cooldown
        console.log('🔌 Disconnecting...');
        ws.close();
        
        // Wait a bit to ensure disconnect completes
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error: any) {
        console.log(`⚠️  Cycle ${i + 1} failed: ${error.message}`);
        // Continue with next cycle
      }
    }
    
    console.log('\n✅ Test complete - review logs above to see cooldown scaling!');
  });
  
  it('demonstrates maximum cooldown under extreme pressure', async () => {
    console.log('\n🌋 EXTREME PRESSURE TEST\n');
    
    // Create many connections in parallel to max out listeners
    const parallelConnections = 15;
    const promises: Promise<void>[] = [];
    
    console.log(`Creating ${parallelConnections} parallel connection attempts...`);
    
    for (let i = 0; i < parallelConnections; i++) {
      const promise = (async () => {
        const params = new URLSearchParams(DEVICE_CONFIG);
        const ws = new WebSocket(`${WS_URL}?${params}`);
        
        try {
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              ws.close();
              resolve();
            }, 1000);
            
            ws.on('message', (data) => {
              const msg = JSON.parse(data.toString());
              if (msg.type === 'connected' || msg.type === 'error') {
                setTimeout(() => {
                  ws.close();
                  resolve();
                }, 100);
              }
            });
            
            ws.on('error', () => resolve());
          });
        } catch (error) {
          // Ignore errors in parallel attempts
        }
      })();
      
      promises.push(promise);
      // Small stagger to avoid complete synchronization
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    
    // Wait for all to complete
    await Promise.allSettled(promises);
    
    // Now make one final connection to see the maximum cooldown
    console.log('\n🎯 Final connection to observe maximum cooldown under pressure:');
    
    const finalParams = new URLSearchParams(DEVICE_CONFIG);
    const finalWs = new WebSocket(`${WS_URL}?${finalParams}`);
    
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        finalWs.close();
        resolve();
      }, 3000);
      
      finalWs.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        console.log(`📨 Received: ${msg.type}`);
        if (msg.type === 'connected') {
          console.log(`✅ Connected under pressure to ${msg.device}`);
        }
        clearTimeout(timeout);
        finalWs.close();
        resolve();
      });
      
      finalWs.on('error', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    
    console.log('\n✅ Extreme pressure test complete!');
  });
});