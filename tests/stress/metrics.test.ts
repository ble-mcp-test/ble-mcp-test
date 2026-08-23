import { describe, it, expect } from 'vitest';
import { LatencyRecorder, SequenceTracker, MemorySampler } from './metrics.js';

describe('LatencyRecorder', () => {
  it('computes percentiles over recorded samples', () => {
    const r = new LatencyRecorder(100);
    for (let i = 1; i <= 100; i++) r.record(i);
    expect(r.count).toBe(100);
    expect(r.percentile(50)).toBe(50);
    expect(r.percentile(99)).toBe(99);
    expect(r.percentile(100)).toBe(100);
  });

  it('counts samples beyond capacity instead of growing', () => {
    const r = new LatencyRecorder(3);
    r.record(1); r.record(2); r.record(3); r.record(4);
    expect(r.count).toBe(3);
    expect(r.overflowed).toBe(1);
  });

  it('reports NaN percentiles when empty rather than throwing', () => {
    const r = new LatencyRecorder(10);
    expect(Number.isNaN(r.percentile(50))).toBe(true);
    expect(r.summary().count).toBe(0);
  });

  it('summarises min, mean and max', () => {
    const r = new LatencyRecorder(10);
    [4, 1, 7].forEach((v) => r.record(v));
    const s = r.summary();
    expect(s.minMs).toBe(1);
    expect(s.maxMs).toBe(7);
    expect(s.meanMs).toBeCloseTo(4, 10);
  });
});

describe('SequenceTracker', () => {
  it('counts a clean run as zero missing', () => {
    const t = new SequenceTracker();
    for (let i = 0; i < 10; i++) t.observe(i);
    expect(t.received).toBe(10);
    expect(t.missing).toBe(0);
    expect(t.outOfOrder).toBe(0);
  });

  it('counts the size of a gap, not the number of gaps', () => {
    const t = new SequenceTracker();
    [0, 1, 5, 6].forEach((s) => t.observe(s));
    expect(t.received).toBe(4);
    expect(t.missing).toBe(3); // 2, 3, 4
  });

  it('credits a late arrival back against the gap it left', () => {
    const t = new SequenceTracker();
    [0, 2, 1].forEach((s) => t.observe(s));
    expect(t.missing).toBe(0);
    expect(t.outOfOrder).toBe(1);
  });
});

describe('MemorySampler', () => {
  it('reports a growth figure across sampled windows', () => {
    const m = new MemorySampler();
    for (let i = 0; i < 8; i++) m.sample();
    const s = m.summary();
    expect(s.samples).toBe(8);
    expect(s.peakRssMB).toBeGreaterThan(0);
    expect(Number.isFinite(s.growthMB)).toBe(true);
  });

  it('reports zeroes rather than NaN when never sampled', () => {
    expect(new MemorySampler().summary()).toEqual({
      samples: 0, firstQuarterMedianMB: 0, lastQuarterMedianMB: 0, growthMB: 0, peakRssMB: 0
    });
  });
});
