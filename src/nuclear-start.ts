#!/usr/bin/env node
/**
 * Nuclear Simple Server Launcher
 */

import { NuclearBridge } from './hybrid-bridge.js';

const bridge = new NuclearBridge();
bridge.start(8084); // Different port for testing

process.on('SIGINT', () => {
  console.log('\n[Nuclear] Shutting down...');
  bridge.stop();
  process.exit(0);
});