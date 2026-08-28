import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { DEFAULT_MOCK_CONFIG, resolveMockConfig, updateMockConfig } from '../../src/mock-bluetooth.js';

/**
 * Where the mock's timing knobs come from, and in what order.
 *
 * Two defects sit behind this file, and they are the same defect.
 *
 * 1. `process.env` was read at MODULE SCOPE, in the file that is the single
 *    runtime-agnostic implementation. A Node API, evaluated at import, in the
 *    code a browser loads.
 *
 * 2. Because of (1), the browser bundle could only work by having esbuild
 *    substitute the five reads at build time -- and the substituted values had
 *    drifted from the source defaults. `BLE_MCP_MOCK_CLEANUP_DELAY` was defined
 *    as "1100" in scripts/build-browser-bundle.js while the source default was
 *    250. TRA-1153 item 6 measured the real figure at a 30ms worst case over 997
 *    disconnect cycles and set 250; every browser test went on paying 1100,
 *    because the define was a second source nobody re-measured.
 *
 * So the resolution order is the contract: defaults < environment <
 * updateMockConfig(). Defaults are plain literals with no runtime behind them,
 * the environment is consulted lazily and guarded so a browser simply finds
 * nothing, and an explicit call always wins.
 */
afterEach(() => {
  // null, not DEFAULT_MOCK_CONFIG: passing the defaults back would PIN them above
  // the environment rather than restore them, and every later test in this file
  // would then read the default no matter what it set.
  updateMockConfig(null);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('BLE_MCP_MOCK_')) delete process.env[key];
  }
});

describe('the resolved mock config', () => {
  it('falls back to the measured defaults with no environment set', () => {
    const config = resolveMockConfig();
    expect(config.postDisconnectDelay).toBe(250);
    expect(config.connectRetryDelay).toBe(250);
    expect(config.maxConnectRetries).toBe(5);
    expect(config.retryBackoffMultiplier).toBe(1.3);
    expect(config.logRetries).toBe(true);
  });

  it('lets the environment override a default', () => {
    process.env.BLE_MCP_MOCK_CLEANUP_DELAY = '600';
    expect(resolveMockConfig().postDisconnectDelay).toBe(600);
  });

  it('reads the environment LAZILY, so a value set after import still lands', () => {
    // The module-scope read made this impossible: by the time a test could set
    // the variable, the value was already frozen into the module.
    expect(resolveMockConfig().maxConnectRetries).toBe(5);
    process.env.BLE_MCP_MOCK_MAX_RETRIES = '3';
    expect(resolveMockConfig().maxConnectRetries).toBe(3);
  });

  it('lets updateMockConfig() beat the environment', () => {
    process.env.BLE_MCP_MOCK_CLEANUP_DELAY = '600';
    updateMockConfig({ postDisconnectDelay: 42 });
    expect(resolveMockConfig().postDisconnectDelay).toBe(42);
  });

  it('ignores an unparseable environment value rather than resolving to NaN', () => {
    // parseInt('banana') is NaN, and NaN silently became the delay: every
    // comparison against it is false, so the post-disconnect wait vanished.
    process.env.BLE_MCP_MOCK_CLEANUP_DELAY = 'banana';
    expect(resolveMockConfig().postDisconnectDelay).toBe(250);
  });

  it('survives an environment with no `process` at all', () => {
    const saved = (globalThis as any).process;
    try {
      delete (globalThis as any).process;
      expect(() => resolveMockConfig()).not.toThrow();
      expect(resolveMockConfig().postDisconnectDelay).toBe(250);
    } finally {
      (globalThis as any).process = saved;
    }
  });
});

describe('the source file itself', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/mock-bluetooth.ts', import.meta.url)),
    'utf-8'
  );

  it('reads no `process.env` at module scope', () => {
    // Mechanical, because the shape is invisible by eye: a module-scope read
    // looks identical to a lazy one at the call site. Every surviving mention
    // must be inside the resolver, reached through `globalThis`.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments, including the JSDoc
      .replace(/\/\/.*$/gm, '');           // line comments
    const reads = code.split('\n').filter(line => /\bprocess\.env\b/.test(line));
    expect(reads).toEqual([]);
  });

  it('still names all five BLE_MCP_MOCK_* variables', () => {
    // bridge/tests/test_env_example.py asserts every variable .env.local.example
    // advertises has a reader, and it looks for these in src/. Losing them here
    // must fail there, not go quiet.
    for (const name of [
      'BLE_MCP_MOCK_RETRY_DELAY',
      'BLE_MCP_MOCK_MAX_RETRIES',
      'BLE_MCP_MOCK_CLEANUP_DELAY',
      'BLE_MCP_MOCK_BACKOFF',
      'BLE_MCP_MOCK_LOG_RETRIES'
    ]) {
      expect(source).toContain(name);
    }
  });
});

describe('the browser bundle build', () => {
  const build = readFileSync(
    fileURLToPath(new URL('../../scripts/build-browser-bundle.js', import.meta.url)),
    'utf-8'
  );

  it('substitutes no config values at build time', () => {
    // This is the check that would have caught the 1100-vs-250 drift. A define
    // is a SECOND source for a value that has one -- it agrees with the source
    // only for as long as somebody keeps re-checking, and nobody did.
    expect(build).not.toContain('process.env.BLE_MCP_MOCK');
  });
});
