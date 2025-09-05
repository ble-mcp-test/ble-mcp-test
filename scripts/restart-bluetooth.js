#!/usr/bin/env node

/**
 * Bluetooth Service Restart Script
 * 
 * Safely restarts the Bluetooth service and related processes to clear zombie states.
 * Can be triggered automatically by zombie detection or run manually.
 */

import { spawn } from 'child_process';
import { MetricsTracker } from '../dist/connection-metrics.js';

const RESTART_TIMEOUT = 30000; // 30 seconds
const RECOVERY_DELAY = 3000;   // 3 seconds after restart

async function executeCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    console.log(`[Bluetooth Restart] Running: ${command} ${args.join(' ')}`);
    
    const process = spawn(command, args, { 
      stdio: 'inherit',
      timeout: RESTART_TIMEOUT 
    });
    
    process.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}: ${command} ${args.join(' ')}`));
      }
    });
    
    process.on('error', (error) => {
      reject(error);
    });
  });
}

async function checkBluetoothStatus() {
  return new Promise((resolve) => {
    const process = spawn('systemctl', ['is-active', 'bluetooth'], { stdio: 'pipe' });
    let output = '';
    
    process.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    process.on('close', (code) => {
      const status = output.trim();
      console.log(`[Bluetooth Restart] Service status: ${status}`);
      resolve({ active: status === 'active', status });
    });
    
    process.on('error', () => {
      resolve({ active: false, status: 'error' });
    });
  });
}

async function waitForBluetoothReady() {
  console.log('[Bluetooth Restart] Waiting for Bluetooth to be ready...');
  
  for (let i = 0; i < 10; i++) {
    const status = await checkBluetoothStatus();
    if (status.active) {
      console.log('[Bluetooth Restart] Bluetooth service is active');
      
      // Additional delay to ensure HCI is ready
      await new Promise(resolve => setTimeout(resolve, RECOVERY_DELAY));
      return true;
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.warn('[Bluetooth Restart] Bluetooth service did not become active within timeout');
  return false;
}

async function restartBluetooth() {
  console.log('\n🔄 Starting Bluetooth Service Restart');
  console.log('════════════════════════════════════');
  
  try {
    // Record restart in metrics
    const metrics = MetricsTracker.getInstance();
    metrics.recordBluetoothRestart();
    
    // Step 1: Stop Bluetooth service
    console.log('\n1. Stopping Bluetooth service...');
    await executeCommand('sudo', ['systemctl', 'stop', 'bluetooth']);
    
    // Step 2: Kill any remaining bluetoothd processes
    console.log('\n2. Killing remaining bluetooth processes...');
    try {
      await executeCommand('sudo', ['pkill', '-f', 'bluetoothd']);
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.log('   No bluetooth processes to kill (this is normal)');
    }
    
    // Step 3: Reset HCI interface (if available)
    console.log('\n3. Resetting HCI interface...');
    try {
      await executeCommand('sudo', ['hciconfig', 'hci0', 'down']);
      await new Promise(resolve => setTimeout(resolve, 500));
      await executeCommand('sudo', ['hciconfig', 'hci0', 'up']);
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.warn('   HCI reset failed (interface may not exist):', error.message);
    }
    
    // Step 4: Start Bluetooth service
    console.log('\n4. Starting Bluetooth service...');
    await executeCommand('sudo', ['systemctl', 'start', 'bluetooth']);
    
    // Step 5: Wait for service to be ready
    console.log('\n5. Waiting for Bluetooth to be ready...');
    const ready = await waitForBluetoothReady();
    
    if (ready) {
      console.log('\n✅ Bluetooth restart completed successfully');
      console.log('   The service should now be ready for new connections');
      console.log('   Restart your bridge server to clear any cached state:');
      console.log('   pnpm pm2:restart');
    } else {
      console.error('\n❌ Bluetooth service restart completed but service is not active');
      console.log('   Manual intervention may be required');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('\n❌ Bluetooth restart failed:', error.message);
    console.log('\nTroubleshooting:');
    console.log('- Ensure you have sudo privileges');
    console.log('- Check if Bluetooth hardware is present: lsusb | grep -i bluetooth');
    console.log('- Check system logs: sudo journalctl -u bluetooth -n 20');
    process.exit(1);
  }
}

// Check if running as a script
if (process.argv[1].endsWith('restart-bluetooth.js')) {
  const reason = process.argv[2] || 'manual restart';
  console.log(`Restarting Bluetooth service: ${reason}`);
  restartBluetooth().catch(console.error);
}

export { restartBluetooth, checkBluetoothStatus };