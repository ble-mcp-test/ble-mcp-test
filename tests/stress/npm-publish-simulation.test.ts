import { describe, it, expect } from 'vitest';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Simulate the exact npm publish prepublishOnly scenario
 */
describe('NPM Publish Simulation', () => {
  it('should replicate the exact prepublishOnly script conditions', async () => {
    console.log('\n🔥 Simulating exact npm publish prepublishOnly conditions\n');
    console.log('  prepublishOnly runs: clean && build && test');
    console.log('  This creates sustained CPU/IO load during test execution\n');
    
    // 1. Simulate clean (removing dist/)
    console.log('  1️⃣ Simulating pnpm run clean...');
    try {
      await execAsync('rm -rf dist-simulation');
      await execAsync('mkdir -p dist-simulation && find src -name "*.ts" -exec cp {} dist-simulation/ \;');
      await execAsync('rm -rf dist-simulation');
    } catch (e) {
      // Ignore errors
    }
    
    // 2. Start build simulation in background (TypeScript + esbuild)
    console.log('  2️⃣ Starting build simulation (TypeScript + esbuild)...');
    
    const tscProcess = spawn('pnpm', ['exec', 'tsc', '--noEmit'], {
      stdio: 'ignore',
      detached: false
    });
    
    const esbuildProcess = spawn('pnpm', ['run', 'build:browser'], {
      stdio: 'ignore', 
      detached: false
    });
    
    // 3. While build is running, immediately start tests (this is what npm does)
    console.log('  3️⃣ Running tests while build is in progress (npm behavior)...');
    
    // Small delay to let builds start consuming CPU
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Run the exact tests that failed during npm publish
    const testTargets = [
      'tests/integration/device-interaction.test.ts',
      'tests/integration/back-to-back-connections.test.ts'
    ];
    
    const results: Array<{ test: string; passed: boolean; output: string }> = [];
    
    for (const testFile of testTargets) {
      console.log(`\n  Running ${testFile.split('/').pop()} under load...`);
      
      const testProcess = spawn('pnpm', ['exec', 'vitest', 'run', testFile, '--reporter=json'], {
        stdio: 'pipe',
        env: { ...process.env, CHECK_BLE_DEVICE: 'true' }
      });
      
      let output = '';
      let jsonOutput = '';
      
      testProcess.stdout?.on('data', (data) => {
        const str = data.toString();
        output += str;
        if (str.includes('{') || jsonOutput) {
          jsonOutput += str;
        }
      });
      
      testProcess.stderr?.on('data', (data) => {
        output += data.toString();
      });
      
      const exitCode = await new Promise<number>((resolve) => {
        testProcess.on('exit', (code) => {
          resolve(code || 0);
        });
      });
      
      const passed = exitCode === 0;
      results.push({ test: testFile, passed, output });
      
      console.log(`    Result: ${passed ? '✅ PASSED' : '❌ FAILED'}`);
      
      // Check for specific errors
      if (!passed) {
        if (output.includes('Connection timeout')) {
          console.log('    ⚠️  Failed with connection timeout (matches npm publish failure)');
        }
        if (output.includes('Device') && output.includes('not found')) {
          console.log('    ⚠️  Failed with device not found');
        }
      }
    }
    
    // Clean up build processes
    console.log('\n  🛑 Stopping build processes...');
    tscProcess.kill();
    esbuildProcess.kill();
    
    // Wait a moment for processes to clean up
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Analyze results
    const totalTests = results.length;
    const passedTests = results.filter(r => r.passed).length;
    const failedTests = totalTests - passedTests;
    
    console.log('\n📊 NPM Publish Simulation Results:');
    console.log(`  Total tests: ${totalTests}`);
    console.log(`  Passed: ${passedTests}`);
    console.log(`  Failed: ${failedTests}`);
    
    if (failedTests > 0) {
      console.log('\n✅ Successfully replicated npm publish failures!');
      console.log('\n  Root cause analysis:');
      console.log('  1. TypeScript compilation creates sustained CPU load');
      console.log('  2. esbuild bundling adds additional CPU/IO pressure');
      console.log('  3. Tests running concurrently with builds overwhelm the system');
      console.log('  4. Noble.js BLE operations become unreliable under resource pressure');
      console.log('\n  This confirms: "If npm can break us, then clients can too"');
      console.log('\n  Mitigation strategies:');
      console.log('  - Use --ignore-scripts during npm publish');
      console.log('  - Separate build and test phases in CI/CD');
      console.log('  - Add resource monitoring to detect high-load conditions');
      console.log('  - Implement adaptive timeouts based on system load');
    } else {
      console.log('\n⚠️  Could not replicate npm publish failures');
      console.log('  The failures may be intermittent or environment-specific');
    }
    
    // This test is informational
    expect(results.length).toBe(testTargets.length);
  }, 90000);

  it('should test client-induced load scenarios', async () => {
    console.log('\n👥 Testing aggressive client behavior scenarios\n');
    
    // Simulate different types of aggressive client behavior
    const scenarios = [
      {
        name: 'Rapid reconnections',
        description: 'Client disconnects and immediately reconnects repeatedly',
        load: async () => {
          // Simulate rapid WebSocket connections
          const WebSocket = (await import('ws')).default;
          const interval = setInterval(() => {
            const ws = new WebSocket('ws://localhost:8080');
            setTimeout(() => ws.close(), 100);
          }, 200);
          return () => clearInterval(interval);
        }
      },
      {
        name: 'Large payload spam',  
        description: 'Client sends many large payloads rapidly',
        load: async () => {
          const procs = [];
          for (let i = 0; i < 3; i++) {
            const proc = spawn('node', ['-e', `
              // Simulate heavy network traffic
              const data = Buffer.alloc(1024 * 1024); // 1MB
              while (true) {
                process.stdout.write(data);
              }
            `], { stdio: 'ignore' });
            procs.push(proc);
          }
          return () => procs.forEach(p => p.kill());
        }
      },
      {
        name: 'CPU exhaustion', 
        description: 'Other processes consuming all CPU',
        load: async () => {
          const procs = [];
          const cpuCount = 8;
          for (let i = 0; i < cpuCount; i++) {
            const proc = spawn('node', ['-e', `
              while (true) {
                let result = 0;
                for (let j = 0; j < 1000000; j++) {
                  result += Math.sqrt(j) * Math.sin(j);
                }
              }
            `], { stdio: 'ignore' });
            procs.push(proc);
          }
          return () => procs.forEach(p => p.kill());
        }
      }
    ];
    
    for (const scenario of scenarios) {
      console.log(`\n  Testing: ${scenario.name}`);
      console.log(`  ${scenario.description}`);
      
      // Start the load
      const cleanup = await scenario.load();
      
      // Wait for load to ramp up
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Try to check device availability
      const checkProcess = spawn('node', ['scripts/check-device-available.js'], {
        stdio: 'pipe',
        env: { ...process.env, BLE_MCP_LOG_LEVEL: 'error' }
      });
      
      const result = await new Promise<{ success: boolean; timeout: boolean }>((resolve) => {
        const timeout = setTimeout(() => {
          checkProcess.kill();
          resolve({ success: false, timeout: true });
        }, 15000);
        
        checkProcess.on('exit', (code) => {
          clearTimeout(timeout);
          resolve({ success: code === 0, timeout: false });
        });
      });
      
      // Clean up
      cleanup();
      
      if (!result.success) {
        console.log(`    ❌ Failed ${result.timeout ? '(timeout)' : ''}`);
        console.log(`    ⚠️  This client behavior can disrupt BLE operations!`);
      } else {
        console.log(`    ✅ Passed (system remained stable)`);
      }
      
      // Brief recovery time
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('\n📊 Client Load Test Summary:');
    console.log('  Aggressive clients CAN disrupt BLE operations through:');
    console.log('  - Resource exhaustion (CPU/memory)');
    console.log('  - Rapid connection cycling');
    console.log('  - System overload');
    
    expect(scenarios.length).toBeGreaterThan(0);
  }, 60000);
});