#!/usr/bin/env node

import { BridgeServer } from './bridge-server.js';
import { normalizeLogLevel } from './utils.js';

const port = parseInt(process.env.WS_PORT || '8080', 10);
const host = process.env.WS_HOST || '0.0.0.0';
const logLevel = normalizeLogLevel(process.env.LOG_LEVEL);

console.log('🚀 Starting WebSocket-to-BLE Bridge Server');
console.log(`   Port: ${port}`);
console.log(`   Host: ${host}`);
console.log(`   Log level: ${logLevel}`);
console.log('   Device-agnostic - UUIDs provided by client');

// Show any BLE timing overrides
const bleOverrides = [
  'BLE_CONNECTION_STABILITY',
  'BLE_PRE_DISCOVERY_DELAY', 
  'BLE_NOBLE_RESET_DELAY',
  'BLE_SCAN_TIMEOUT',
  'BLE_CONNECTION_TIMEOUT',
  'BLE_DISCONNECT_COOLDOWN'
].filter(key => process.env[key]);

if (bleOverrides.length > 0) {
  console.log('   BLE timing overrides:');
  bleOverrides.forEach(key => {
    console.log(`     ${key}: ${process.env[key]}ms`);
  });
}

console.log('   Press Ctrl+C to stop\n');

const server = new BridgeServer(logLevel);

// Start server and handle startup errors
server.start(port).catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  server.stop();
  process.exit(0);
});