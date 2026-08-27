import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CONFORMANCE_CHECKS, partitionChecks, type ConformanceCheck } from './contract.js';
import { createMockProvider, type MockProvider } from './mock-provider.js';
import { STUB_BRIDGE_CAVEAT } from './stub-bridge.js';
import { armBStatus, banner, ARM_B_ENV } from './arm-status.js';

/**
 * Arm A: every contract check, against the mock, over a real connect.
 *
 * The check bodies live in contract.ts and know nothing about vitest, because the
 * same bodies are bundled into a Chromium page for arm B. This file is only the
 * wrapper.
 */
let provider: MockProvider;

beforeAll(async () => {
  provider = await createMockProvider();
});

afterAll(async () => {
  const { runnable, skipped } = partitionChecks(provider);
  // Printed at the end, where a reader looks. The scope caveat and arm B's
  // status travel WITH the pass count, because a bare "N passed" quoted out of
  // context supports a much stronger conclusion than this run demonstrates.
  console.log(
    banner(
      provider.name,
      runnable.length,
      skipped.map(entry => ({ id: entry.check.id, because: entry.because })),
      STUB_BRIDGE_CAVEAT,
      armBStatus(process.env)
    )
  );
  await provider?.shutdown();
});

const { runnable, skipped } = partitionChecks({
  // partitionChecks only reads capabilities, and arm A's are static -- so the
  // suite can be built at collection time, before beforeAll has run.
  name: 'arm A (mock + in-process stub bridge)',
  capabilities: { injectNotification: true, dropLink: true, testingApi: true }
} as MockProvider);

function runCheck(check: ConformanceCheck) {
  it(`${check.category} :: ${check.id} -- ${check.clause}`, async () => {
    const session = await provider.open();
    try {
      await check.run(session, provider);
    } finally {
      await provider.close(session);
    }
  });
}

describe('client contract, arm A', () => {
  describe('fidelity clauses (must also hold of real navigator.bluetooth)', () => {
    runnable.filter(c => c.category === 'fidelity').forEach(runCheck);
  });

  describe('deliberate divergences (the mock is stricter, on purpose)', () => {
    runnable.filter(c => c.category === 'divergence').forEach(runCheck);
  });

  describe('mock-only surface (testing.*)', () => {
    runnable.filter(c => c.category === 'mock-only').forEach(runCheck);
  });
});

describe('the suite reports what it did NOT do', () => {
  it('runs every check the mock provider is capable of', () => {
    // Nothing is skipped in arm A: it can inject, it can drop, it has testing.*.
    // If that ever stops being true this fails, naming the check -- which is the
    // opposite of a suite that quietly shrinks.
    expect(skipped.map(entry => entry.check.id)).toEqual([]);
    expect(runnable.length).toBe(CONFORMANCE_CHECKS.length);
  });

  it('names arm B in the banner, and says it did not run', () => {
    const status = armBStatus({});
    expect(status.requested).toBe(false);
    expect(status.line).toContain('arm B');
    expect(status.line).toContain('DID NOT RUN');
    expect(status.line).toContain(ARM_B_ENV);
  });

  it('carries the stub bridge caveat into the printed line, not only the header', () => {
    // A caveat in a file header is one nobody reads at the moment they need it.
    const line = banner('arm A', 3, [], STUB_BRIDGE_CAVEAT, armBStatus({}));
    expect(line).toContain('proves the client surface');
    expect(line).toContain('no release timing');
    expect(line).toContain('DID NOT RUN');
  });
});
