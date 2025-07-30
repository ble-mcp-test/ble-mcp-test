#!/usr/bin/env node

import { BridgeServer } from './bridge-server.js';
import { normalizeLogLevel } from './utils.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHttpApp, startHttpServer } from './mcp-http-transport.js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env.local if it exists
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// Parse command line arguments
const args = process.argv.slice(2);
// MCP is always enabled - it's in our product name!

const port = parseInt(process.env.BLE_MCP_WS_PORT || '8080', 10);
const host = process.env.BLE_MCP_WS_HOST || '0.0.0.0';
const logLevel = normalizeLogLevel(process.env.BLE_MCP_LOG_LEVEL);
const mcpToken = process.env.BLE_MCP_HTTP_TOKEN;

// Only enable HTTP transport if explicitly requested
const httpPort = process.env.BLE_MCP_HTTP_PORT;
const enableHttpTransport = args.includes('--mcp-http') || !!httpPort || !!mcpToken;

console.log('🚀 Starting ble-mcp-test Server');
console.log('\n📡 Bridge Configuration:');
console.log(`   WebSocket: ${host}:${port}`);
console.log(`   Log level: ${logLevel}`);
console.log('   Device-agnostic - UUIDs provided by client');

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

// Show MCP configuration
console.log('\n🔌 MCP Server Configuration:');

// Check if we have TTY for stdio
const hasTty = process.stdin.isTTY && process.stdout.isTTY;
const stdioDisabled = process.env.BLE_MCP_STDIO_DISABLED === 'true';
if (hasTty && !stdioDisabled) {
  console.log('   Stdio transport: Enabled (default)');
} else if (stdioDisabled) {
  console.log('   Stdio transport: Disabled (BLE_MCP_STDIO_DISABLED set)');
} else {
  console.log('   Stdio transport: Disabled (no TTY)');
}

if (enableHttpTransport) {
  console.log(`   HTTP transport: Port ${httpPort || '8081'}`);
  if (mcpToken) {
    console.log('   Authentication: Bearer token required');
  } else {
    console.log('   Authentication: ⚠️  None (local network only!)');
  }
} else {
  console.log('   HTTP transport: Disabled (use --mcp-http or set BLE_MCP_HTTP_TOKEN/BLE_MCP_HTTP_PORT to enable)');
}

console.log('\n   Press Ctrl+C to stop\n');

const server = new BridgeServer(logLevel);

// Start server and handle startup errors
server.start(port).catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

// Initialize MCP transports - always enabled
const mcpServer = server.getMcpServer();

// Auto-detect TTY and enable stdio transport (default)
if (hasTty && !stdioDisabled) {
  const stdioTransport = new StdioServerTransport();
  mcpServer.connect(stdioTransport).then(() => {
    console.log('[MCP] Stdio transport connected');
  }).catch(error => {
    console.error('[MCP] Failed to connect stdio transport:', error);
  });
}

// Start HTTP transport only if explicitly enabled
if (enableHttpTransport) {
  const httpApp = createHttpApp(mcpServer, mcpToken);
  startHttpServer(httpApp);
}

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
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  server.stop();
  process.exit(0);
});