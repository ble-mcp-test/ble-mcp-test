/**
 * Measurement primitives for the firehose harness.
 *
 * Allocation behaviour matters here: this code runs inside the process whose
 * heap growth it is reporting. The latency store is preallocated and the
 * sequence tracker keeps O(1) state, so neither can manufacture the growth the
 * harness exists to detect.
 */

const BYTES_PER_MB = 1024 * 1024;

export interface LatencySummary {
  count: number;
  overflowed: number;
  minMs: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
  p999Ms: number;
  maxMs: number;
  meanMs: number;
}

export class LatencyRecorder {
  private readonly samples: Float64Array;
  private n = 0;
  private overflow = 0;
  private sum = 0;
  private sorted = false;

  constructor(capacity: number) {
    this.samples = new Float64Array(Math.max(1, Math.floor(capacity)));
  }

  record(ms: number): void {
    if (this.n < this.samples.length) {
      this.samples[this.n++] = ms;
      this.sum += ms;
      this.sorted = false;
    } else {
      this.overflow++;
    }
  }

  get count(): number { return this.n; }
  get overflowed(): number { return this.overflow; }

  private ensureSorted(): void {
    if (this.sorted) return;
    this.samples.subarray(0, this.n).sort();
    this.sorted = true;
  }

  /** Nearest-rank percentile. `p` is 0-100. NaN when nothing was recorded. */
  percentile(p: number): number {
    if (this.n === 0) return NaN;
    this.ensureSorted();
    const rank = Math.ceil((p / 100) * this.n);
    const idx = Math.min(this.n - 1, Math.max(0, rank - 1));
    return this.samples[idx];
  }

  summary(): LatencySummary {
    if (this.n === 0) {
      return {
        count: 0, overflowed: this.overflow,
        minMs: NaN, p50Ms: NaN, p90Ms: NaN, p99Ms: NaN, p999Ms: NaN, maxMs: NaN, meanMs: NaN
      };
    }
    this.ensureSorted();
    return {
      count: this.n,
      overflowed: this.overflow,
      minMs: this.samples[0],
      p50Ms: this.percentile(50),
      p90Ms: this.percentile(90),
      p99Ms: this.percentile(99),
      p999Ms: this.percentile(99.9),
      maxMs: this.samples[this.n - 1],
      meanMs: this.sum / this.n
    };
  }
}

/**
 * Tracks loss over a single ordered stream using O(1) state.
 *
 * `missing` is the SIZE of the gaps, not the number of them: three consecutive
 * dropped notifications count as three, which is the figure "no message loss"
 * is actually a claim about.
 */
export class SequenceTracker {
  private highest = -1;
  private receivedCount = 0;
  private missingCount = 0;
  private outOfOrderCount = 0;

  observe(seq: number): void {
    this.receivedCount++;
    if (seq > this.highest) {
      this.missingCount += seq - this.highest - 1;
      this.highest = seq;
    } else {
      this.outOfOrderCount++;
      if (this.missingCount > 0) this.missingCount--;
    }
  }

  get received(): number { return this.receivedCount; }
  get missing(): number { return this.missingCount; }
  get outOfOrder(): number { return this.outOfOrderCount; }
}

export interface MemorySummary {
  samples: number;
  firstQuarterMedianMB: number;
  lastQuarterMedianMB: number;
  growthMB: number;
  peakRssMB: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Samples heap and RSS on demand. Compares the median of the first quarter of
 * samples against the median of the last quarter: a single first-vs-last
 * reading is at the mercy of whenever GC happened to run.
 */
export class MemorySampler {
  private heapMB: number[] = [];
  private rssMB: number[] = [];

  sample(): void {
    const m = process.memoryUsage();
    this.heapMB.push(m.heapUsed / BYTES_PER_MB);
    this.rssMB.push(m.rss / BYTES_PER_MB);
  }

  get count(): number { return this.heapMB.length; }

  summary(): MemorySummary {
    const n = this.heapMB.length;
    if (n === 0) {
      return { samples: 0, firstQuarterMedianMB: 0, lastQuarterMedianMB: 0, growthMB: 0, peakRssMB: 0 };
    }
    const q = Math.max(1, Math.floor(n / 4));
    const first = median(this.heapMB.slice(0, q));
    const last = median(this.heapMB.slice(n - q));
    return {
      samples: n,
      firstQuarterMedianMB: first,
      lastQuarterMedianMB: last,
      growthMB: last - first,
      peakRssMB: Math.max(...this.rssMB)
    };
  }
}
