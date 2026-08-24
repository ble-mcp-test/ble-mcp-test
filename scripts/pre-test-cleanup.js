#!/usr/bin/env node

/**
 * Pre-test cleanup script
 * Ensures clean test environment by:
 * 1. Killing any processes using our test ports
 * 2. Stopping any Noble/BLE scanning
 * 3. Providing cooldown period for hardware recovery
 */

import { execSync } from 'child_process';
import { readdirSync, readFileSync, realpathSync } from 'fs';
import net from 'net';
import path from 'path';
import { killPort } from './port-cleanup.js';

const DEFAULT_TEST_PORTS = [8080, 8081, 8082, 8083];
const COOLDOWN_MS = 5000;

/**
 * Ports to sweep. `BLE_MCP_TEST_PORTS` overrides the default so tests can point
 * this script at a scratch port instead of at the real bridge on 8080.
 *
 * Set-but-unparseable throws. A silent fall back to the defaults would sweep
 * 8080 while the operator's evidence said otherwise -- the second failure class
 * in CLAUDE.md, and a close relative of the bug this script just had.
 */
function resolveTestPorts(raw) {
  if (raw === undefined) return DEFAULT_TEST_PORTS;
  const ports = raw.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (!ports.length || ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error(`BLE_MCP_TEST_PORTS is set but is not a comma-separated port list: ${JSON.stringify(raw)}`);
  }
  return ports;
}

const TEST_PORTS = resolveTestPorts(process.env.BLE_MCP_TEST_PORTS);

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

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

/** PID of a process's parent, or null. */
function parentOf(pid) {
  try {
    // Field 4 of /proc/<pid>/stat, read after the comm field, which may itself
    // contain spaces or parentheses.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(after[1]) || null;
  } catch { return null; }
}

/**
 * Orphaned vitest runners belonging to THIS repository.
 *
 * Deliberately NOT `pkill -f "node.*test"`. That matches any command line
 * containing the substring "test" -- and a command line contains the absolute
 * path of the script being run. A worktree named `test+tra-1167` in an
 * unrelated repository therefore looked like a test runner and was killed
 * mid-`eslint --fix`, in a different project, belonging to someone else.
 * Paths carry branch names, ticket ids and directory names, so an
 * argv-substring match silently inherits whatever anyone named a folder.
 *
 * The same pattern also matched this script's own parent `pnpm run test:unit`,
 * so the cleanup killed the test run it was preparing for.
 *
 * So: identify rather than pattern-match. A process qualifies only if its
 * working directory is inside this project AND it is a vitest runner AND it is
 * not this process or one of its ancestors.
 */
function ownTestRunners() {
  const lineage = new Set();
  for (let p = process.pid; p && p !== 1 && !lineage.has(p); p = parentOf(p)) {
    lineage.add(p);
  }

  const found = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (lineage.has(pid)) continue;

    let cwd, argv;
    try {
      cwd = realpathSync(`/proc/${pid}/cwd`);
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
      continue; // exited, or not ours to inspect
    }
    if (cwd !== PROJECT_ROOT && !cwd.startsWith(PROJECT_ROOT + path.sep)) continue;
    // Match the executable, not a substring of the whole command line.
    if (!argv.some((a) => path.basename(a) === 'vitest' || a.endsWith('/vitest.mjs'))) continue;
    found.push(pid);
  }
  return found;
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
  
  // 2. Kill orphaned test runners belonging to THIS repository
  console.log('\nChecking for orphaned test processes...');
  const orphans = ownTestRunners();
  if (orphans.length) {
    console.log(`  Found ${orphans.length} orphaned test runner(s): ${orphans.join(', ')}`);
    for (const pid of orphans) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    killedAny = true;
  } else {
    console.log('  ✓ No orphaned test processes');
  }
  
  // 3. Ensure Noble is cleaned up
  // Skip inline noble cleanup - it causes issues with ES modules
  
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