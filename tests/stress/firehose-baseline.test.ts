import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { runFirehose } from './firehose-harness.js';
import type { FirehoseResult } from './firehose-harness.js';

/**
 * The sustained rate ladder — the actual TRA-1156 deliverable.
 *
 * Opt-in because it saturates a shared machine. Enable with FIREHOSE_BASELINE=1,
 * and only on a box nobody else is measuring on: a latency baseline recorded
 * under someone else's load is a number with a story attached, not a baseline.
 *
 *   FIREHOSE_BASELINE=1 pnpm run stress:firehose
 *   FIREHOSE_BASELINE=1 FIREHOSE_RATES=450,4500 FIREHOSE_SECONDS=120 pnpm run stress:firehose
 */
const ENABLED = process.env.FIREHOSE_BASELINE === '1';
const RATES = (process.env.FIREHOSE_RATES ?? '450,900,2250,4500')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);
const SECONDS = parseInt(process.env.FIREHOSE_SECONDS ?? '60', 10);
const LABEL = process.env.FIREHOSE_LABEL ?? 'baseline';
const OUT = process.env.FIREHOSE_OUT ?? `tmp/firehose/${LABEL}.json`;

function formatRow(r: FirehoseResult): string {
  const pct = (n: number) => n.toFixed(2).padStart(8);
  return [
    String(r.targetRatePerSec).padStart(6),
    r.achievedRatePerSec.toFixed(1).padStart(9),
    String(r.injected).padStart(9),
    String(r.received).padStart(9),
    String(r.lost).padStart(6),
    pct(r.latency.p50Ms),
    pct(r.latency.p99Ms),
    pct(r.latency.maxMs),
    r.memory.growthMB.toFixed(1).padStart(9),
    String(r.saturatedTicks).padStart(8)
  ].join(' ');
}

describe.skipIf(!ENABLED)('firehose baseline ladder', () => {
  it(`records ${RATES.join('/')} msg/s for ${SECONDS}s each`, async () => {
    const results: FirehoseResult[] = [];

    console.log(`\n  rate   achieved  injected  received   lost      p50      p99      max   heapMB  satTicks`);
    for (const rate of RATES) {
      const result = await runFirehose({ ratePerSec: rate, durationMs: SECONDS * 1000 });
      results.push(result);
      console.log(`  ${formatRow(result)}`);
    }

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify({
      label: LABEL,
      stack: 'typescript-bridge',
      node: process.version,
      productionRatePerSec: 45,
      secondsPerRate: SECONDS,
      results
    }, null, 2));
    console.log(`\n  wrote ${OUT}\n`);

    for (const r of results) {
      expect(r.lost, `message loss at ${r.targetRatePerSec} msg/s`).toBe(0);
      expect(r.missing, `sequence gaps at ${r.targetRatePerSec} msg/s`).toBe(0);
    }
  }, RATES.length * (SECONDS + 30) * 1000);
});
