import { describe, it, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import WebSocket from 'ws';
import { WS_URL, getDeviceConfig } from '../test-config.js';
import noble from '@stoprocent/noble';

const DEVICE_CONFIG = getDeviceConfig();

describe('Simulated Listener Buildup Test', () => {
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
  
  it('demonstrates cooldown scaling by simulating listener buildup', async () => {
    console.log('\n🔬 SIMULATED LISTENER BUILDUP TEST\n');
    console.log('Simulating what happens when Noble accumulates listeners over time...\n');
    
    // Artificially add scanStop listeners to simulate buildup
    // This mimics what happens in real usage when Noble internals accumulate listeners
    const addListeners = (count: number) => {
      for (let i = 0; i < count; i++) {
        noble.on('scanStop', () => {});
      }
    };
    
    // Test different levels of listener pressure
    const pressureLevels = [
      { listeners: 0, description: 'No pressure (fresh start)' },
      { listeners: 5, description: 'Light pressure (after ~5 tests)' },
      { listeners: 12, description: 'Moderate pressure (after ~12 tests)' },
      { listeners: 25, description: 'High pressure (after ~25 tests)' },
      { listeners: 50, description: 'Very high pressure (after ~50 tests)' },
      { listeners: 100, description: 'Extreme pressure (after ~100 tests)' }
    ];
    
    for (const level of pressureLevels) {
      // Reset listeners
      noble.removeAllListeners('scanStop');
      
      // Add the specified number of listeners
      addListeners(level.listeners);
      
      console.log(`\n📊 ${level.description}`);
      console.log(`   Current scanStop listeners: ${noble.listenerCount('scanStop')}`);
      
      // Perform a connection/disconnection
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
        
        // Disconnect to trigger cooldown calculation
        console.log('   🔌 Disconnecting to observe cooldown...');
        ws.close();
        
        // Wait for disconnect to complete
        await new Promise(resolve => setTimeout(resolve, 300));
        
      } catch (error: any) {
        console.log(`   ⚠️  Failed: ${error.message}`);
      }
    }
    
    console.log('\n📈 Cooldown Scaling Summary:');
    console.log('   Base cooldown: 200ms (macOS)');
    console.log('   Scaling formula: base + (floor(listeners/5) * 500ms)');
    console.log('   Examples:');
    console.log('   - 0-4 listeners: 200ms');
    console.log('   - 5-9 listeners: 700ms (+500ms)');
    console.log('   - 10-14 listeners: 1200ms (+1000ms)');
    console.log('   - 25-29 listeners: 2700ms (+2500ms)');
    console.log('   - 50-54 listeners: 5200ms (+5000ms)');
    console.log('   - 100+ listeners: 10200ms (+10000ms)');
    
    console.log('\n✅ Test complete - review cooldown values above!');
    
    // Clean up the artificial listeners
    noble.removeAllListeners('scanStop');
  });
});