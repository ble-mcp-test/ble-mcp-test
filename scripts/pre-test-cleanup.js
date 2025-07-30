#!/usr/bin/env node

/**
 * Pre-test cleanup script
 * Ensures clean test environment by:
 * 1. Killing any processes using our test ports
 * 2. Stopping any Noble/BLE scanning
 * 3. Providing cooldown period for hardware recovery
 */

import { execSync } from 'child_process';
import net from 'net';

const TEST_PORTS = [8080, 8081, 8082, 8083];
const COOLDOWN_MS = 5000;

console.log('🧹 Pre-test cleanup starting...');

// Function to check if port is in use
async function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

// Function to kill process using port
function killPort(port) {
  try {
    // Find process using the port
    const pid = execSync(`lsof -t -i:${port}`, { encoding: 'utf8' }).trim();
    if (pid) {
      console.log(`  Killing process ${pid} on port ${port}`);
      execSync(`kill -9 ${pid}`);
      return true;
    }
  } catch (e) {
    // lsof returns error if no process found
  }
  return false;
}

// Main cleanup
async function cleanup() {
  let killedAny = false;
  
  // 1. Check and kill processes on test ports
  console.log('Checking test ports...');
  for (const port of TEST_PORTS) {
    const inUse = await isPortInUse(port);
    if (inUse) {
      if (killPort(port)) {
        killedAny = true;
      }
    } else {
      console.log(`  Port ${port}: ✓ free`);
    }
  }
  
  // 2. Kill any node processes that might be holding BLE
  console.log('\nChecking for orphaned test processes...');
  try {
    const processes = execSync('ps aux | grep -E "(vitest|node.*test)" | grep -v grep | grep -v pre-test-cleanup', { encoding: 'utf8' });
    if (processes.trim()) {
      console.log('  Found test processes:');
      console.log(processes);
      execSync('pkill -f "vitest" || true');
      execSync('pkill -f "node.*test" || true');
      killedAny = true;
    } else {
      console.log('  ✓ No orphaned test processes');
    }
  } catch (e) {
    console.log('  ✓ No orphaned test processes');
  }
  
  // 3. Ensure Noble is cleaned up
  try {
    // Create a quick Noble cleanup script
    const cleanupScript = `
      import noble from '@stoprocent/noble';
      noble.stopScanningAsync().catch(() => {});
      setTimeout(() => process.exit(0), 100);
    `;
    execSync(`node -e "${cleanupScript}"`, { stdio: 'ignore' });
  } catch (e) {
    // Ignore errors
  }
  
  // 4. Apply cooldown period if we killed anything
  if (killedAny) {
    console.log(`\n⏳ Applying ${COOLDOWN_MS}ms cooldown for hardware recovery...`);
    await new Promise(resolve => setTimeout(resolve, COOLDOWN_MS));
  }
  
  // 5. Check if BLE device is available (only for integration tests)
  const isIntegrationTest = process.argv.some(arg => 
    arg.includes('integration') || 
    arg.includes('e2e') ||
    process.env.CHECK_BLE_DEVICE === 'true'
  );
  
  if (isIntegrationTest) {
    console.log('\nChecking BLE device availability...');
    try {
      execSync('node scripts/check-device-available.js', { stdio: 'inherit' });
    } catch (e) {
      console.error('\n' + '='.repeat(60));
      console.error('🚨 HARDWARE CHECK FAILED - ACTION REQUIRED 🚨');
      console.error('='.repeat(60));
      console.error('\nThe BLE device is not responding to scans.');
      console.error('\n⚠️  DO NOT PROCEED WITHOUT ASKING THE USER!');
      console.error('⚠️  DO NOT ASSUME HARDWARE IS UNAVAILABLE!');
      console.error('⚠️  THE HARDWARE EXISTS - IT NEEDS ATTENTION!');
      console.error('\n' + '='.repeat(60) + '\n');
      process.exit(1);
    }
  }
  
  console.log('\n✅ Pre-test cleanup complete!');
}

// Run cleanup
cleanup().catch(console.error);