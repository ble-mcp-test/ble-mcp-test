#!/usr/bin/env node

import { BridgeServer } from './bridge-server.js';
import { ObservabilityServer } from './observability-server.js';
import { SharedState } from './shared-state.js';
import { normalizeLogLevel } from './utils.js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env.local if it exists
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// Parse command line arguments
const args = process.argv.slice(2);

const wsPort = parseInt(process.env.BLE_MCP_WS_PORT || '8080', 10);
const host = process.env.BLE_MCP_WS_HOST || '0.0.0.0';
const logLevel = normalizeLogLevel(process.env.BLE_MCP_LOG_LEVEL);
const httpPort = parseInt(process.env.BLE_MCP_HTTP_PORT || '8081', 10);

console.log('🚀 Starting ble-mcp-test Services');
console.log('\n📡 Service 1: WebSocket Bridge');
console.log(`   Port: ${wsPort}`);
console.log(`   Host: ${host}`);
console.log(`   Purpose: BLE byte tunneling`);

// Show any BLE timing overrides
const bleOverrides = [
  'BLE_MCP_RECOVERY_DELAY',
  'BLE_MCP_SCAN_TIMEOUT',
  'BLE_MCP_CONNECTION_TIMEOUT'
].filter(key => process.env[key]);

if (bleOverrides.length > 0) {
  console.log('   BLE timing overrides:');
  bleOverrides.forEach(key => {
    console.log(`     ${key}: ${process.env[key]}ms`);
  });
}

console.log('\n📊 Service 2: Observability Server');
console.log(`   Port: ${httpPort}`);
console.log(`   Health check: http://localhost:${httpPort}/health`);
console.log(`   MCP tools: http://localhost:${httpPort}/mcp/info`);

if (process.env.BLE_MCP_HTTP_TOKEN) {
  console.log('   Authentication: Bearer token required');
} else {
  console.log('   Authentication: ⚠️  None (local network only!)');
}

console.log('\n   Press Ctrl+C to stop\n');

// Create shared state for both services
const sharedState = new SharedState();

// Start Service 1: WebSocket Bridge
const bridgeServer = new BridgeServer(logLevel, sharedState);
bridgeServer.start(wsPort).catch(error => {
  console.error('Failed to start bridge server:', error);
  process.exit(1);
});

// Start Service 2: Observability Server
const observabilityServer = new ObservabilityServer(sharedState);
observabilityServer.connectToBridge(bridgeServer);

// Start HTTP server for health checks and MCP
observabilityServer.startHttp(httpPort).catch(error => {
  console.error('Failed to start observability server:', error);
  process.exit(1);
});

// Connect stdio transport if available
observabilityServer.connectStdio().catch(error => {
  console.error('Failed to connect stdio transport:', error);
});

// Handle uncaught errors to prevent server crash
process.on('uncaughtException', (error) => {
  console.error('[CRITICAL] Uncaught exception:', error);
  console.error('Stack:', error.stack);
  // Don't exit - try to keep server running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled promise rejection at:', promise);
  console.error('Reason:', reason);
  // Don't exit - try to keep server running
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  bridgeServer.stop();
  sharedState.restoreConsole();
  process.exit(0);
});

process.on('SIGTERM', () => {
  bridgeServer.stop();
  sharedState.restoreConsole();
  process.exit(0);
});