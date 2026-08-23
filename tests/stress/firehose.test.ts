import { describe, it, expect } from 'vitest';
import { runFirehose } from './firehose-harness.js';

// Deliberately low rate. A peer agent is running a timing-sensitive hardware
// soak on this box; these tests must stay below its noise floor. The sustained
// rate ladder lives in firehose-baseline.test.ts and is opt-in.
describe('firehose harness', () => {
  it('relays every injected notification through the real bridge with no loss', async () => {
    const result = await runFirehose({ ratePerSec: 50, durationMs: 2000 });

    expect(result.injected).toBeGreaterThan(50);
    expect(result.received).toBe(result.injected);
    expect(result.lost).toBe(0);
    expect(result.missing).toBe(0);
    expect(result.outOfOrder).toBe(0);
  }, 30000);

  it('achieves the requested rate and records latency percentiles', async () => {
    const result = await runFirehose({ ratePerSec: 50, durationMs: 2000 });

    expect(result.achievedRatePerSec).toBeGreaterThan(40);
    expect(result.achievedRatePerSec).toBeLessThan(60);
    expect(result.saturatedTicks).toBe(0);

    expect(result.latency.count).toBeGreaterThan(0);
    expect(result.latency.p50Ms).toBeGreaterThanOrEqual(0);
    expect(result.latency.p99Ms).toBeGreaterThanOrEqual(result.latency.p50Ms);
    expect(result.latency.p99Ms).toBeLessThan(1000);
  }, 30000);

  it('samples memory across the run', async () => {
    const result = await runFirehose({ ratePerSec: 50, durationMs: 2000, memorySampleMs: 100 });
    expect(result.memory.samples).toBeGreaterThan(5);
    expect(result.memory.peakRssMB).toBeGreaterThan(0);
  }, 30000);
});

// Negative control. A harness that always reports zero loss is
// indistinguishable from one that cannot detect loss at all, so break the
// subject deliberately and confirm the accounting notices.
describe('firehose harness self-test', () => {
  it('reports loss when notifications are deliberately discarded', async () => {
    const result = await runFirehose({ ratePerSec: 50, durationMs: 2000, dropEveryNth: 10 });

    expect(result.injected).toBeGreaterThan(50);
    expect(result.lost).toBeGreaterThan(0);
    expect(result.missing).toBeGreaterThan(0);
    // One in ten discarded, within a generous tolerance for drain timing.
    expect(result.lost).toBeGreaterThanOrEqual(Math.floor(result.injected / 20));
    expect(result.lost).toBeLessThanOrEqual(Math.ceil(result.injected / 5));
  }, 30000);
});
