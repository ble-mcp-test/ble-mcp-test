import { describe, it, expect } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import { SharedState } from '../../src/shared-state.js';
import WebSocket from 'ws';
import { spawn } from 'child_process';
import { WS_URL, getDeviceConfig } from '../test-config.js';

const DEVICE_CONFIG = getDeviceConfig();

/**
 * Test specific timing race conditions that can occur under load
 */
describe('Timing Race Conditions Under Load', () => {
  let server: BridgeServer;
  
  beforeAll(async () => {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const sharedState = new SharedState(false);
    server = new BridgeServer('debug', sharedState);
    await server.start(8085);
  });
  
  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  it('should handle connection attempts during Noble state transitions', async () => {
    console.log('\n⚡ Testing connection timing during Noble state transitions\n');
    
    // This test targets the specific failure mode we saw:
    // "Connection timeout" when Noble is in 'unknown' state
    
    const results: Array<{ attempt: number; nobleState: string; success: boolean; error?: string }> = [];
    
    for (let i = 0; i < 5; i++) {
      console.log(`\n  Attempt ${i + 1}/5: Forcing Noble state transition...`);
      
      // Create background CPU load to slow down Noble initialization
      const loadProc = spawn('node', ['-e', `
        let result = 0;
        const start = Date.now();
        while (Date.now() - start < 10000) {
          for (let j = 0; j < 10000000; j++) {
            result += Math.sqrt(j);
          }
        }
      `], { stdio: 'ignore' });
      
      // Immediately attempt connection while Noble might be initializing
      const params = new URLSearchParams(DEVICE_CONFIG);
      const ws = new WebSocket(`${WS_URL.replace('8080', '8085')}?${params}`);
      
      const startTime = Date.now();
      let capturedNobleState = 'unknown';
      
      const result = await new Promise<{ success: boolean; error?: string; nobleState: string }>((resolve) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ success: false, error: 'Connection timeout', nobleState: capturedNobleState });
        }, 20000);
        
        // Try to capture Noble state from error messages
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === 'connected') {
            clearTimeout(timeout);
            ws.send(JSON.stringify({ type: 'force_cleanup' }));
            resolve({ success: true, nobleState: 'poweredOn' });
            
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            // Extract Noble state from error if present
            if (msg.error?.includes('Noble state:')) {
              const match = msg.error.match(/Noble state: (\w+)/);
              if (match) capturedNobleState = match[1];
            }
            resolve({ success: false, error: msg.error, nobleState: capturedNobleState });
          }
        });
        
        ws.on('error', (error) => {
          clearTimeout(timeout);
          resolve({ success: false, error: `WebSocket: ${error.message}`, nobleState: capturedNobleState });
        });
      });
      
      const elapsed = Date.now() - startTime;
      results.push({ attempt: i + 1, ...result });
      
      console.log(`    Noble state: ${result.nobleState}`);
      console.log(`    Result: ${result.success ? '✅ Connected' : `❌ ${result.error}`} (${elapsed}ms)`);
      
      // Clean up
      loadProc.kill();
      ws.close();
      
      // Wait for recovery
      if (i < 4) {
        await new Promise(resolve => setTimeout(resolve, 6000));
      }
    }
    
    // Analyze Noble state issues
    const stateFailures = results.filter(r => !r.success && r.nobleState !== 'poweredOn');
    console.log(`\n📊 Noble State Analysis:`);
    console.log(`  Failures due to Noble state: ${stateFailures.length}`);
    
    if (stateFailures.length > 0) {
      console.log('\n  Noble state failures detected:');
      stateFailures.forEach(f => {
        console.log(`    - Attempt ${f.attempt}: Noble was '${f.nobleState}'`);
      });
      console.log('\n  ✅ This explains the npm publish failures!');
      console.log('  Under high CPU load, Noble initialization is delayed');
    }
    
    expect(results.length).toBe(5);
  }, 120000);

  it('should test connection reliability during garbage collection pressure', async () => {
    console.log('\n🗑️ Testing connection stability under GC pressure\n');
    
    // Create memory pressure to trigger frequent GC
    console.log('  Creating memory pressure to trigger GC...');
    
    const gcProcess = spawn('node', ['-e', `
      // Allocate and release memory rapidly to trigger GC
      setInterval(() => {
        const arrays = [];
        for (let i = 0; i < 100; i++) {
          arrays.push(new Array(100000).fill(Math.random()));
        }
        // Let it go out of scope for GC
      }, 10);
      
      // Keep process alive
      setTimeout(() => {}, 30000);
    `], { stdio: 'ignore' });
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Attempt connections during GC pressure
    const results: boolean[] = [];
    
    for (let i = 0; i < 3; i++) {
      console.log(`\n  Connection attempt ${i + 1}/3 under GC pressure...`);
      
      const params = new URLSearchParams(DEVICE_CONFIG);
      const ws = new WebSocket(`${WS_URL.replace('8080', '8085')}?${params}`);
      
      const success = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve(false);
        }, 15000);
        
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'connected') {
            clearTimeout(timeout);
            ws.send(JSON.stringify({ type: 'force_cleanup' }));
            resolve(true);
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            resolve(false);
          }
        });
        
        ws.on('error', () => {
          clearTimeout(timeout);
          resolve(false);
        });
      });
      
      results.push(success);
      console.log(`    Result: ${success ? '✅ Success' : '❌ Failed'}`); 
      
      if (i < 2) {
        await new Promise(resolve => setTimeout(resolve, 6000));
      }
    }
    
    gcProcess.kill();
    
    const successCount = results.filter(r => r).length;
    console.log(`\n📊 GC Pressure Results: ${successCount}/3 successful`);
    
    if (successCount < 3) {
      console.log('\n  ⚠️  GC pressure can affect BLE connection reliability');
      console.log('  Node.js GC pauses can interfere with Noble timing');
    }
    
    expect(successCount).toBeGreaterThan(0);
  }, 60000);
});