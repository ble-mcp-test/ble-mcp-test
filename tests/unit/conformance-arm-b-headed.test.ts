import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ARM_B_ENV } from '../conformance/arm-status.js';

/**
 * Arm B cannot run headless, and for months the config said so in prose while
 * setting `headless: true` in code.
 *
 * `requestDevice()` requires a user-driven chooser. A headless Chromium has no
 * chooser to drive, so the call never resolves and the run dies on the spec's
 * 120s timeout — which reads as a dead adapter or an out-of-range peripheral,
 * not as a misconfigured browser. That is failure class 1 from CLAUDE.md
 * exactly: a wait whose condition nothing on the other side can satisfy.
 *
 * The header of playwright.conformance.config.ts already called a headed run
 * "a deliberate, recorded exception for `just conformance-real`". Nothing
 * implemented it. This test is what keeps the prose and the code in step, and
 * it derives the trigger from ARM_B_ENV rather than restating '1' locally, so
 * the spec and the config cannot drift onto different switches.
 */
describe('arm B runs headed', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env[ARM_B_ENV];
  });

  const loadConfig = async () => (await import('../../playwright.conformance.config.js')).default;

  it('is headed when arm B is requested, because the chooser needs a human', async () => {
    process.env[ARM_B_ENV] = '1';
    const config = await loadConfig();
    expect(
      config.use?.headless,
      `${ARM_B_ENV}=1 means a human is about to answer Chrome's device chooser. ` +
        'A headless browser shows no chooser, so requestDevice() hangs until the ' +
        'test times out and the failure reads as broken hardware.',
    ).toBe(false);
  });

  it('budgets the timeout for a human, not for a machine', async () => {
    process.env[ARM_B_ENV] = '1';
    const config = await loadConfig();
    expect(
      config.timeout,
      'Every runnable check calls provider.open(), so the operator answers the ' +
        'chooser once per check, and all of them run inside one page.evaluate ' +
        'sharing a single test timeout. A machine-sized budget expires partway ' +
        'through a live run and reads as a dead adapter.',
    ).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });

  it('leaves headless alone when arm B is not requested', async () => {
    const config = await loadConfig();
    expect(
      config.use?.headless,
      'Without arm B requested the spec skips, and CLAUDE.md\'s headless rule stands.',
    ).toBe(true);
  });
});
