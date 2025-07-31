import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../../src/index.js';
import { SharedState } from '../../src/shared-state.js';
import WebSocket from 'ws';
import { spawn } from 'child_process';
import { WS_URL, getDeviceConfig } from '../test-config.js';

const DEVICE_CONFIG = getDeviceConfig();

/**
 * Replicate the high-load scenario from prepublishOnly script
 * that caused test failures during npm publish.
 * 
 * Theory: The prepublishOnly script runs:
 * 1. pnpm run clean (removes dist/)
 * 2. pnpm run build (compiles TypeScript + bundles browser)
 * 3. pnpm run test (runs all tests)
 * 
 * The concurrent build processes might create CPU/IO load that
 * affects Noble's BLE timing, causing connection failures.
 */
describe.sequential('Prepublish Load Replication', () => {
  let server: BridgeServer;
  
  beforeAll(async () => {
    // Wait for any previous tests to clean up
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const sharedState = new SharedState(false);
    server = new BridgeServer('debug', sharedState);
    await server.start(8084); // Use different port
  });
  
  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  it('should handle connections while under high CPU/IO load', async () => {
    console.log('\n🔥 Replicating prepublishOnly high-load scenario');
    console.log('  Simulating: clean + build + test concurrent load\n');
    
    // Start background load processes to simulate prepublishOnly
    const loadProcesses: any[] = [];
    
    // 1. Simulate TypeScript compilation load
    const tscProcess = spawn('pnpm', ['exec', 'tsc', '--noEmit'], {
      stdio: 'ignore',
      detached: false
    });
    loadProcesses.push(tscProcess);
    console.log('  📦 Started TypeScript compilation (simulating build load)');
    
    // 2. Simulate esbuild bundling load
    const esbuildProcess = spawn('pnpm', ['run', 'build:browser'], {
      stdio: 'ignore',
      detached: false
    });
    loadProcesses.push(esbuildProcess);
    console.log('  📦 Started esbuild bundling (simulating browser build)');
    
    // 3. Simulate disk I/O load (like clean + rebuild)
    const ioLoadProcess = spawn('find', ['.', '-name', '*.ts', '-exec', 'wc', '-l', '{}', '+'], {
      stdio: 'ignore',
      detached: false
    });
    loadProcesses.push(ioLoadProcess);
    console.log('  💾 Started disk I/O load (simulating file operations)');
    
    // Give load processes time to ramp up
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Now attempt connections while under load
    console.log('\n  🔌 Attempting connections under high load...');
    const results: Array<{ attempt: number; success: boolean; error?: string; time: number }> = [];
    const attempts = 10;
    
    for (let i = 0; i < attempts; i++) {
      const startTime = Date.now();
      const params = new URLSearchParams(DEVICE_CONFIG);
      const ws = new WebSocket(`${WS_URL.replace('8080', '8084')}?${params}`);
      
      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ success: false, error: 'Connection timeout under load' });
        }, 15000); // 15s timeout for high-load scenario
        
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === 'connected') {
            // Send test command
            ws.send(JSON.stringify({
              type: 'data',
              data: [0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00]
            }));
            
          } else if (msg.type === 'data') {
            // Got response, initiate cleanup
            ws.send(JSON.stringify({ type: 'force_cleanup' }));
            
          } else if (msg.type === 'force_cleanup_complete') {
            clearTimeout(timeout);
            ws.close();
            resolve({ success: true });
            
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            ws.close();
            resolve({ success: false, error: msg.error });
          }
        });
        
        ws.on('error', (error) => {
          clearTimeout(timeout);
          resolve({ success: false, error: `WebSocket error: ${error.message}` });
        });
        
        ws.on('close', () => {
          clearTimeout(timeout);
          resolve({ success: false, error: 'Connection closed unexpectedly' });
        });
      });
      
      const time = Date.now() - startTime;
      results.push({ attempt: i + 1, ...result, time });
      
      if (result.success) {
        console.log(`    Attempt ${i + 1}/${attempts}: ✅ Connected (${time}ms)`);
      } else {
        console.log(`    Attempt ${i + 1}/${attempts}: ❌ ${result.error} (${time}ms)`);
      }
      
      // Wait for recovery period between attempts
      if (i < attempts - 1) {
        await new Promise(resolve => setTimeout(resolve, 6000));
      }
    }
    
    // Clean up load processes
    console.log('\n  🛑 Stopping load processes...');
    loadProcesses.forEach(proc => {
      try {
        proc.kill('SIGTERM');
      } catch (e) {
        // Process may have already exited
      }
    });
    
    // Analyze results
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    const timeouts = results.filter(r => r.error?.includes('timeout')).length;
    const avgTime = results.reduce((sum, r) => sum + r.time, 0) / results.length;
    const successRate = (successful / attempts) * 100;
    
    console.log('\n📊 High-Load Test Results:');
    console.log(`  Successful connections: ${successful}/${attempts}`);
    console.log(`  Failed connections: ${failed}/${attempts}`);
    console.log(`  Connection timeouts: ${timeouts}`);
    console.log(`  Average connection time: ${Math.round(avgTime)}ms`);
    console.log(`  Success rate: ${successRate.toFixed(1)}%`);
    
    // Group errors
    const errorCounts = results.reduce((acc, r) => {
      if (r.error) {
        acc[r.error] = (acc[r.error] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>);
    
    console.log('\n  Error breakdown:');
    Object.entries(errorCounts).forEach(([error, count]) => {
      console.log(`    ${error}: ${count}`);
    });
    
    // Under high load, we expect some failures but not complete failure
    // The prepublishOnly script showed 2 failures out of many tests
    expect(successful).toBeGreaterThan(0); // At least some should succeed
    expect(successRate).toBeGreaterThan(30); // Reasonable threshold under load
    
    console.log(`\n${successRate >= 50 ? '✅' : '⚠️'} High-load scenario completed with ${successRate.toFixed(1)}% success rate`);
    
    if (successRate < 50) {
      console.log('\n⚠️  Low success rate confirms that high CPU/IO load can trigger failures');
      console.log('   This explains the prepublishOnly test failures during npm publish');
    }
  }, 60000); // 60s timeout for entire test

  it('should test connection stability during concurrent test suite execution', async () => {
    console.log('\n🔥 Testing connection stability during concurrent test execution');
    console.log('  Simulating: Multiple test files running simultaneously\n');
    
    // Start a test suite in the background to create realistic test load
    const testProcess = spawn('pnpm', ['run', 'test:unit'], {
      stdio: 'ignore',
      detached: false
    });
    
    console.log('  🧪 Started unit test suite in background');
    
    // Give tests time to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Attempt connections while tests are running
    const results: Array<{ success: boolean; error?: string }> = [];
    
    for (let i = 0; i < 5; i++) {
      console.log(`\n  Connection attempt ${i + 1}/5 while tests running...`);
      
      const params = new URLSearchParams(DEVICE_CONFIG);
      const ws = new WebSocket(`${WS_URL.replace('8080', '8084')}?${params}`);
      
      const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ success: false, error: 'Timeout during concurrent tests' });
        }, 10000);
        
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === 'connected') {
            clearTimeout(timeout);
            ws.send(JSON.stringify({ type: 'force_cleanup' }));
            resolve({ success: true });
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            resolve({ success: false, error: msg.error });
          }
        });
        
        ws.on('error', () => {
          clearTimeout(timeout);
          resolve({ success: false, error: 'WebSocket error during tests' });
        });
      });
      
      results.push(result);
      console.log(`    Result: ${result.success ? '✅ Success' : `❌ ${result.error}`}`);
      
      if (i < 4) {
        await new Promise(resolve => setTimeout(resolve, 5500));
      }
    }
    
    // Stop test process
    testProcess.kill('SIGTERM');
    
    const successCount = results.filter(r => r.success).length;
    console.log(`\n📊 Concurrent test execution results: ${successCount}/5 successful`);
    
    // Should maintain some stability even during test execution
    expect(successCount).toBeGreaterThan(0);
  }, 45000);
});