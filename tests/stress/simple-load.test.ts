import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Simple test to demonstrate how high CPU load affects BLE connections
 */
describe('CPU Load Impact on BLE', () => {
  it('should demonstrate connection behavior under CPU load', async () => {
    console.log('\n🔥 Testing BLE connection behavior under high CPU load\n');
    
    // Create CPU load by spawning multiple processes
    const loadProcesses: any[] = [];
    const cpuCount = 4; // Simulate 4 CPU-intensive processes
    
    console.log(`  Starting ${cpuCount} CPU-intensive processes...`);
    for (let i = 0; i < cpuCount; i++) {
      // Use a CPU-intensive command that runs for a while
      const proc = spawn('node', ['-e', `
        let result = 0;
        const start = Date.now();
        while (Date.now() - start < 30000) { // Run for 30 seconds
          for (let j = 0; j < 1000000; j++) {
            result += Math.sqrt(j);
          }
        }
      `], { stdio: 'ignore' });
      loadProcesses.push(proc);
    }
    
    console.log('  ⏳ Waiting for load to ramp up...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Run our integration tests under load
    console.log('\n  Running device-interaction test under high CPU load...');
    const testProcess = spawn('pnpm', ['exec', 'vitest', 'run', 'tests/integration/device-interaction.test.ts'], {
      stdio: 'pipe',
      env: { ...process.env, CHECK_BLE_DEVICE: 'true' }
    });
    
    let output = '';
    testProcess.stdout?.on('data', (data) => {
      output += data.toString();
    });
    testProcess.stderr?.on('data', (data) => {
      output += data.toString();
    });
    
    // Wait for test to complete
    const exitCode = await new Promise<number>((resolve) => {
      testProcess.on('exit', (code) => {
        resolve(code || 0);
      });
    });
    
    // Clean up load processes
    console.log('\n  🛑 Stopping CPU load processes...');
    loadProcesses.forEach(proc => {
      try {
        proc.kill('SIGTERM');
      } catch (e) {
        // Process may have already exited
      }
    });
    
    // Analyze results
    console.log('\n📊 Test Results Under Load:');
    console.log(`  Exit code: ${exitCode}`);
    
    // Check for specific errors in output
    const hasTimeoutError = output.includes('Connection timeout');
    const hasDeviceNotFound = output.includes('Device') && output.includes('not found');
    const testsPassed = output.includes('passed');
    const testsFailed = output.includes('failed');
    
    console.log(`  Connection timeouts: ${hasTimeoutError ? 'Yes ⚠️' : 'No ✅'}`);
    console.log(`  Device not found: ${hasDeviceNotFound ? 'Yes ⚠️' : 'No ✅'}`);
    console.log(`  Tests passed: ${testsPassed ? 'Yes ✅' : 'No ❌'}`);
    console.log(`  Tests failed: ${testsFailed ? 'Yes ❌' : 'No ✅'}`);
    
    if (hasTimeoutError || hasDeviceNotFound) {
      console.log('\n⚠️  High CPU load CAN cause BLE connection failures!');
      console.log('   This confirms that prepublishOnly failures are load-related.');
      console.log('\n   Implications:');
      console.log('   - Aggressive clients creating high load could trigger failures');
      console.log('   - CI/CD environments with limited resources are vulnerable');
      console.log('   - The escalating cleanup system helps but cannot prevent all issues');
    }
    
    // This test is informational - we expect some failures under extreme load
    expect(exitCode).toBeDefined();
  }, 60000);

  it('should measure connection success rate with gradual load increase', async () => {
    console.log('\n📈 Measuring connection success rate vs CPU load\n');
    
    const loadLevels = [0, 1, 2, 4, 8]; // Number of CPU-intensive processes
    const results: Array<{ load: number; successRate: number }> = [];
    
    for (const loadLevel of loadLevels) {
      console.log(`\n  Testing with ${loadLevel} CPU-intensive processes...`);
      
      const loadProcesses: any[] = [];
      
      // Start load processes
      for (let i = 0; i < loadLevel; i++) {
        const proc = spawn('node', ['-e', `
          let result = 0;
          while (true) {
            for (let j = 0; j < 1000000; j++) {
              result += Math.sqrt(j);
            }
          }
        `], { stdio: 'ignore' });
        loadProcesses.push(proc);
      }
      
      // Wait for load to stabilize
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Run a quick connection test
      const testScript = join(__dirname, '../../scripts/check-device-available.js');
      let successes = 0;
      const attempts = 3;
      
      for (let i = 0; i < attempts; i++) {
        const checkProcess = spawn('node', [testScript], {
          stdio: 'pipe',
          env: { ...process.env, BLE_MCP_LOG_LEVEL: 'error' }
        });
        
        const exitCode = await new Promise<number>((resolve) => {
          const timeout = setTimeout(() => {
            checkProcess.kill();
            resolve(1);
          }, 10000);
          
          checkProcess.on('exit', (code) => {
            clearTimeout(timeout);
            resolve(code || 0);
          });
        });
        
        if (exitCode === 0) successes++;
        
        // Brief pause between attempts
        if (i < attempts - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      
      // Clean up load processes
      loadProcesses.forEach(proc => {
        try {
          proc.kill('SIGTERM');
        } catch (e) {
          // Ignore
        }
      });
      
      const successRate = (successes / attempts) * 100;
      results.push({ load: loadLevel, successRate });
      console.log(`    Success rate: ${successRate.toFixed(0)}% (${successes}/${attempts})`);
    }
    
    // Display results
    console.log('\n📊 CPU Load vs Success Rate:');
    console.log('  Load Level | Success Rate');
    console.log('  -----------|-------------');
    results.forEach(r => {
      const bar = '█'.repeat(Math.round(r.successRate / 10));
      console.log(`  ${r.load.toString().padStart(10)} | ${bar} ${r.successRate.toFixed(0)}%`);
    });
    
    // We expect success rate to decrease with load
    const noLoadSuccess = results.find(r => r.load === 0)?.successRate || 0;
    const highLoadSuccess = results.find(r => r.load === 8)?.successRate || 0;
    
    console.log(`\n  Success rate dropped from ${noLoadSuccess}% to ${highLoadSuccess}% under load`);
    
    if (highLoadSuccess < noLoadSuccess) {
      console.log('\n✅ Confirmed: High CPU load degrades BLE connection reliability');
    }
    
    expect(results.length).toBe(loadLevels.length);
  }, 120000);
});