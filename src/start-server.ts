#!/usr/bin/env node

import { BridgeServer } from './bridge-server.js';

const port = parseInt(process.env.WS_PORT || '8080', 10);
const host = process.env.WS_HOST || '0.0.0.0';

console.log('🚀 Starting WebSocket-to-BLE Bridge Server');
console.log(`   Port: ${port}`);
console.log(`   Host: ${host}`);
console.log(`   Device: ${process.env.CS108_DEVICE_NAME || 'ANY (first CS108 found)'}`);
console.log('   Press Ctrl+C to stop\n');

const server = new BridgeServer();
server.start(port);

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