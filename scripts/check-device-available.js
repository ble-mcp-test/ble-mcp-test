#!/usr/bin/env node

/**
 * Check if BLE device is available before running tests
 * Exit codes:
 *   0 - Device found and ready
 *   1 - Device not found or error
 */

import noble from '@stoprocent/noble';
import dotenv from 'dotenv';
import { resolve } from 'path';

// Load environment variables
dotenv.config({ path: resolve(process.cwd(), '.env.local') });

const deviceIdentifier = process.env['BLE_MCP_DEVICE_IDENTIFIER'];
if (!deviceIdentifier) {
  console.error('❌ BLE_MCP_DEVICE_IDENTIFIER not set');
  console.error('Set it to either a MAC address (e.g., 6c79b82603a7) or device name (e.g., CS108-260572)');
  process.exit(1);
}

console.log(`🔍 Checking for BLE device: ${deviceIdentifier}`);

async function checkDevice(timeoutMs = 5000) {
  // Wait for Bluetooth adapter to be powered on
  if (noble.state !== 'poweredOn') {
    console.log('⏳ Waiting for Bluetooth to power on...');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Bluetooth not powered on')), 5000);
      noble.once('stateChange', (state) => {
        if (state === 'poweredOn') {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }

  // Set up timeout
  const timeoutHandle = setTimeout(() => {
    console.error(`❌ Device ${deviceIdentifier} not found after ${timeoutMs/1000}s`);
    console.error('');
    console.error('Please check:');
    console.error('  1. CS108 device is powered on');
    console.error('  2. Device is in range');
    console.error('  3. Try: sudo systemctl restart bluetooth');
    stopAndExit(1);
  }, timeoutMs);

  // Handle device discovery
  noble.on('discover', (peripheral) => {
    const id = peripheral.id;
    const name = peripheral.advertisement.localName || '';
    
    if (id.startsWith(deviceIdentifier) || name.startsWith(deviceIdentifier)) {
      clearTimeout(timeoutHandle);
      console.log(`✅ Found device: ${name || 'Unknown'} [${id}] RSSI: ${peripheral.rssi}`);
      stopAndExit(0);
    }
  });

  // Start scanning with duplicates (critical for CS108 on Linux)
  await noble.startScanningAsync([], true);
  console.log('📡 Scanning...');
}

async function stopAndExit(code) {
  try {
    await noble.stopScanningAsync();
  } catch (e) {
    // Ignore
  }
  
  // Clean up to prevent hanging
  noble.removeAllListeners('discover');
  noble.removeAllListeners('stateChange');
  
  process.exit(code);
}

// Run the check
checkDevice().catch((err) => {
  console.error('❌ Error:', err.message);
  stopAndExit(1);
});