#!/usr/bin/env node

/**
 * Test Timeout Manager
 * Manages PM2 environment variables for testing timeouts
 */

import { execSync } from 'child_process';

const SHORT_GRACE_PERIOD = 3;
const SHORT_IDLE_TIMEOUT = 10;
const NORMAL_GRACE_PERIOD = 60;
const NORMAL_IDLE_TIMEOUT = 300;

function setShortTimeouts() {
  console.log('🔧 Setting short timeouts for testing...');
  execSync(`pnpm exec pm2 set ble-mcp-test:BLE_SESSION_GRACE_PERIOD_SEC ${SHORT_GRACE_PERIOD}`, { stdio: 'inherit' });
  execSync(`pnpm exec pm2 set ble-mcp-test:BLE_SESSION_IDLE_TIMEOUT_SEC ${SHORT_IDLE_TIMEOUT}`, { stdio: 'inherit' });
  console.log(`✅ Set timeouts: grace=${SHORT_GRACE_PERIOD}s, idle=${SHORT_IDLE_TIMEOUT}s`);
}

function setNormalTimeouts() {
  console.log('🔧 Restoring normal timeouts...');
  execSync(`pnpm exec pm2 set ble-mcp-test:BLE_SESSION_GRACE_PERIOD_SEC ${NORMAL_GRACE_PERIOD}`, { stdio: 'inherit' });
  execSync(`pnpm exec pm2 set ble-mcp-test:BLE_SESSION_IDLE_TIMEOUT_SEC ${NORMAL_IDLE_TIMEOUT}`, { stdio: 'inherit' });
  console.log(`✅ Restored timeouts: grace=${NORMAL_GRACE_PERIOD}s, idle=${NORMAL_IDLE_TIMEOUT}s`);
}

const command = process.argv[2];

switch (command) {
  case 'short':
    setShortTimeouts();
    break;
  case 'normal':
    setNormalTimeouts();
    break;
  default:
    console.log('Usage: node scripts/test-timeout-manager.js <short|normal>');
    process.exit(1);
}