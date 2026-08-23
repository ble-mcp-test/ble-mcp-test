# Firehose Stress Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an injected-notification load generator that drives the current TypeScript bridge at 10–100× the ~45 msg/s production rate with no hardware, no radio and no reader, and records message loss, per-notification latency percentiles, and heap growth.

**Architecture:** The bridge already has exactly one place where a BLE device enters the system — `BleSession` constructs a `NobleTransport`. We add a `BleTransport` interface plus an optional `TransportFactory` threaded through `BridgeServer → SessionManager → BleSession`, defaulting to `new NobleTransport(config)` so production behaviour is unchanged. The harness supplies a `FirehoseTransport` that synthesises notifications at a controlled rate, each carrying a sequence number and an injection timestamp in its payload. A WebSocket client in the same process consumes the resulting `data` frames and computes loss, latency and memory growth. Everything runs in one Node process on an OS-assigned ephemeral port bound to loopback.

**Tech Stack:** TypeScript (ES2022, strict), Node 24, `ws`, vitest, pnpm.

**Spec:** `docs/design/2026-08-23-replatform-tickets.md` §T2, plus TRA-1156. Supporting context: `docs/design/2026-08-23-bleak-esphome-notify-audit.md` §3 (the `[inferred]` claim this harness exists to convert into data) and `docs/design/2026-08-23-ws-protocol-spec.md` (the `data` message shape).

## Global Constraints

- **pnpm EXCLUSIVELY.** Never `npm`, `npx`, or `yarn`. `npx` → `pnpm dlx` or `pnpm exec`.
- **Never bind or connect to `127.0.0.1:8080`.** A peer agent (`platform`, TRA-1167) owns the running bridge and the CS108 reader for an extended soak. The harness binds an OS-assigned ephemeral port on `127.0.0.1` and connects only to that.
- **No hardware, no radio, no reader.** `AF_BLUETOOTH` fails with errno 97 in this container; nothing in this plan may require a Bluetooth stack.
- **No sustained high-rate runs without clearance.** Functional verification runs at ≤100 msg/s. The sustained rate ladder (Task 8) waits for an explicitly quiet box — agreed with `platform`, who is running a timing-sensitive soak on the same 24 cores. Anything saturating the box for >30s needs a ping first.
- **No `cargo` builds.** TypeScript only. A `cargo build` pins 24 cores and is the same contamination wearing different clothes.
- **Keep files under 500 lines.**
- **DELETE, don't deprecate** — no `.old` files, no commented-out code.
- **Device identifiers are masked past the OUI.** The synthetic transport must not introduce a device name or MAC resembling the real reader.
- **`pnpm exec tsc --noEmit` only covers `src/**`** (`tsconfig.json` sets `"include": ["src/**/*"]` and `"rootDir": "./src"`). Harness code under `tests/` is therefore NOT typechecked by the repo's validate command. Task 2 adds `tsconfig.test.json` and a `typecheck:tests` script; both typechecks must pass before commit.

---

### Task 1: Transport seam in the bridge

Introduce the injection point. This is the only change to `src/`, and it must be behaviour-neutral in production: with no factory supplied, every path constructs a `NobleTransport` exactly as it does today.

**Files:**
- Create: `src/ble-transport.ts`
- Modify: `src/ble-session.ts:1-45` (import, field type, constructor, transport construction)
- Modify: `src/session-manager.ts:31` (constructor), `src/session-manager.ts:79` (BleSession construction)
- Modify: `src/bridge-server.ts:25-33` (constructor, `start()` signature and bind)
- Test: `tests/unit/transport-seam.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface BleTransport extends EventEmitter { connect(): Promise<{ name: string; id: string }>; write(data: Uint8Array): Promise<void>; cleanup(): Promise<void>; isConnected(): boolean }`
  - `type TransportFactory = (config: BleConfig) => BleTransport`
  - `new BridgeServer(logLevel?: string, sharedState?: SharedState, transportFactory?: TransportFactory)`
  - `BridgeServer.start(port?: number, host?: string): Promise<number>` — resolves to the actually-bound port.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/transport-seam.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { BridgeServer } from '../../src/bridge-server.js';
import type { BleTransport } from '../../src/ble-transport.js';
import type { BleConfig } from '../../src/noble-transport.js';

class StubTransport extends EventEmitter implements BleTransport {
  connected = false;
  readonly writes: Uint8Array[] = [];
  constructor(public readonly config: BleConfig) { super(); }
  async connect() { this.connected = true; return { name: 'StubDevice', id: 'stub' }; }
  async write(data: Uint8Array) { this.writes.push(data); }
  async cleanup() { this.connected = false; }
  isConnected() { return this.connected; }
}

let server: BridgeServer | null = null;

afterEach(async () => {
  if (server) { await server.stop(); server = null; }
});

describe('transport seam', () => {
  it('uses the injected factory instead of NobleTransport, and never touches a radio', async () => {
    const built: StubTransport[] = [];
    server = new BridgeServer(undefined, undefined, (cfg) => {
      const t = new StubTransport(cfg);
      built.push(t);
      return t;
    });

    const port = await server.start(0, '127.0.0.1');
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(8080);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/?service=9800&write=9900&notify=9901`);
    const connected = await new Promise<any>((resolve, reject) => {
      ws.on('message', (raw) => resolve(JSON.parse(raw.toString())));
      ws.on('error', reject);
    });

    expect(connected).toEqual({ type: 'connected', device: 'StubDevice' });
    expect(built).toHaveLength(1);
    expect(built[0].config.service).toBe('9800');
    expect(built[0].isConnected()).toBe(true);

    ws.close();
  });

  it('forwards transport data events to the WebSocket as `data` frames', async () => {
    let transport: StubTransport | null = null;
    server = new BridgeServer(undefined, undefined, (cfg) => {
      transport = new StubTransport(cfg);
      return transport;
    });
    const port = await server.start(0, '127.0.0.1');

    const ws = new WebSocket(`ws://127.0.0.1:${port}/?service=9800&write=9900&notify=9901`);
    const frames: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        frames.push(msg);
        if (msg.type === 'connected') resolve();
      });
      ws.on('error', reject);
    });

    transport!.emit('data', new Uint8Array([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 50));

    expect(frames).toContainEqual({ type: 'data', data: [1, 2, 3] });
    ws.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/transport-seam.test.ts`
Expected: FAIL — `Cannot find module '../../src/ble-transport.js'`, and `BridgeServer` takes only two constructor arguments.

- [ ] **Step 3: Create the transport interface**

Create `src/ble-transport.ts`:

```typescript
import type { EventEmitter } from 'events';
import type { BleConfig } from './noble-transport.js';

/**
 * The transport surface BleSession actually uses.
 *
 * NobleTransport satisfies this structurally. Declaring it separately gives the
 * bridge a single injection point: a harness can drive the relay at rate with no
 * radio and no reader present (see tests/stress/firehose-transport.ts), and the
 * Python rewrite has an explicit contract to reproduce.
 *
 * Events: 'data' (Uint8Array), 'disconnect' ().
 */
export interface BleTransport extends EventEmitter {
  connect(): Promise<{ name: string; id: string }>;
  write(data: Uint8Array): Promise<void>;
  cleanup(): Promise<void>;
  isConnected(): boolean;
}

/** Builds a transport for one session. Defaults to NobleTransport everywhere in production. */
export type TransportFactory = (config: BleConfig) => BleTransport;
```

- [ ] **Step 4: Thread the factory through BleSession**

In `src/ble-session.ts`, add the import:

```typescript
import type { BleTransport, TransportFactory } from './ble-transport.js';
```

Change the field declaration from `private transport: NobleTransport | null = null;` to:

```typescript
  private transport: BleTransport | null = null;
```

Change the constructor to:

```typescript
  constructor(
    public readonly sessionId: string,
    private config: BleConfig,
    private sharedState: SharedState | null = null,
    private transportFactory: TransportFactory = (cfg: BleConfig) => new NobleTransport(cfg)
  ) {
    super();
  }
```

Change the construction line inside `connect()` from `this.transport = new NobleTransport(this.config);` to:

```typescript
      this.transport = this.transportFactory(this.config);
```

Leave the comment above it (`// Create transport and let it handle all BLE operations`) in place.

- [ ] **Step 5: Thread the factory through SessionManager**

In `src/session-manager.ts`, add the import:

```typescript
import type { TransportFactory } from './ble-transport.js';
```

Change the constructor at line 31 to:

```typescript
  constructor(
    private sharedState?: SharedState,
    private transportFactory?: TransportFactory
  ) {}
```

Change the construction at line 79 to:

```typescript
      session = new BleSession(sessionId, config, this.sharedState, this.transportFactory);
```

`BleSession`'s fourth parameter has a default, so passing `undefined` selects `NobleTransport` — production behaviour is unchanged.

- [ ] **Step 6: Thread the factory through BridgeServer and return the bound port**

In `src/bridge-server.ts`, add the imports:

```typescript
import type { AddressInfo } from 'net';
import type { TransportFactory } from './ble-transport.js';
```

Change the constructor to:

```typescript
  constructor(logLevel?: string, sharedState?: SharedState, transportFactory?: TransportFactory) {
    this.sessionManager = new SessionManager(sharedState, transportFactory);
    console.log(`[Bridge] Session-based architecture initialized`);
  }
```

Replace the first three lines of `start()` — currently:

```typescript
  async start(port = 8080) {
    this.wss = new WebSocketServer({ port });
    console.log(`🚀 Session-based bridge listening on port ${port}`);
```

with:

```typescript
  async start(port = 8080, host?: string): Promise<number> {
    this.wss = new WebSocketServer(host ? { port, host } : { port });

    // Await the bind so callers can learn the actually-assigned port. Passing 0
    // requests an ephemeral port, which is how tests avoid colliding with a
    // bridge someone else is running on 8080.
    const wss = this.wss;
    const boundPort = await new Promise<number>((resolve, reject) => {
      const onListening = () => {
        wss.off('error', onError);
        resolve((wss.address() as AddressInfo).port);
      };
      const onError = (err: Error) => {
        wss.off('listening', onListening);
        reject(err);
      };
      wss.once('listening', onListening);
      wss.once('error', onError);
    });

    console.log(`🚀 Session-based bridge listening on port ${boundPort}`);
```

Then add `return boundPort;` as the last statement of `start()`, after the `this.wss.on('connection', ...)` registration closes.

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/unit/transport-seam.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 8: Verify production behaviour is unchanged**

Run: `pnpm exec tsc --noEmit && pnpm exec vitest run tests/unit`
Expected: typecheck clean; all existing unit tests still pass. Record the actual counts — do not assume.

- [ ] **Step 9: Commit**

```bash
git add src/ble-transport.ts src/ble-session.ts src/session-manager.ts src/bridge-server.ts tests/unit/transport-seam.test.ts
git commit -m "feat: add an injectable BLE transport seam to the bridge

BleSession constructed NobleTransport unconditionally, so the relay could
only be exercised with a radio present. Add a BleTransport interface and an
optional TransportFactory threaded through BridgeServer, SessionManager and
BleSession, defaulting to NobleTransport so production behaviour is unchanged.
start() now awaits the bind and returns the assigned port so tests can use an
ephemeral one.

Refs: TRA-1156"
```

---

### Task 2: Metrics primitives

Loss, latency percentiles and memory growth, with allocation behaviour that cannot itself cause the growth being measured. This is why the latency store is a preallocated `Float64Array` and the sequence tracker holds no per-message state.

**Files:**
- Create: `tests/stress/metrics.ts`
- Create: `tsconfig.test.json`
- Modify: `package.json` (add `typecheck:tests` script)
- Test: `tests/stress/metrics.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class LatencyRecorder { constructor(capacity: number); record(ms: number): void; get count(): number; get overflowed(): number; percentile(p: number): number; summary(): LatencySummary }`
  - `interface LatencySummary { count: number; overflowed: number; minMs: number; p50Ms: number; p90Ms: number; p99Ms: number; p999Ms: number; maxMs: number; meanMs: number }`
  - `class SequenceTracker { observe(seq: number): void; get received(): number; get missing(): number; get outOfOrder(): number }`
  - `class MemorySampler { sample(): void; get count(): number; summary(): MemorySummary }`
  - `interface MemorySummary { samples: number; firstQuarterMedianMB: number; lastQuarterMedianMB: number; growthMB: number; peakRssMB: number }`

- [ ] **Step 1: Write the failing test**

Create `tests/stress/metrics.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/stress/metrics.test.ts`
Expected: FAIL — `Cannot find module './metrics.js'`.

- [ ] **Step 3: Implement the metrics module**

Create `tests/stress/metrics.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/stress/metrics.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Add a typecheck that covers `tests/`**

`tsconfig.json` sets `"include": ["src/**/*"]`, so none of this file is typechecked by `pnpm exec tsc --noEmit`. Create `tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": ".",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Add to `package.json` scripts, immediately after the existing `"typecheck"` entry:

```json
    "typecheck:tests": "tsc --noEmit -p tsconfig.test.json",
```

- [ ] **Step 6: Run both typechecks**

Run: `pnpm exec tsc --noEmit && pnpm run typecheck:tests`
Expected: both clean. If `tsconfig.test.json` surfaces pre-existing errors in other test files, fix only what this plan introduced and note the rest in the PR body — do not silently widen `exclude` to hide them.

- [ ] **Step 7: Commit**

```bash
git add tests/stress/metrics.ts tests/stress/metrics.test.ts tsconfig.test.json package.json
git commit -m "test: add measurement primitives for the firehose harness

LatencyRecorder preallocates a Float64Array and SequenceTracker keeps O(1)
state, so neither can manufacture the heap growth the harness is meant to
detect. Adds tsconfig.test.json because tsconfig.json includes only src/**,
leaving harness code untypechecked by the repo's validate command.

Refs: TRA-1156"
```

---

### Task 3: The injecting transport

The load generator itself: a `BleTransport` that emits synthetic notifications at a controlled rate, each carrying its sequence number and injection timestamp.

**Files:**
- Create: `tests/stress/firehose-transport.ts`
- Test: `tests/stress/firehose-transport.test.ts`

**Interfaces:**
- Consumes: `BleTransport` from `src/ble-transport.ts` (Task 1).
- Produces:
  - `const FIREHOSE_HEADER_BYTES = 12`
  - `function encodeFirehosePayload(seq: number, tInjectMs: number, payloadBytes: number): Uint8Array`
  - `function decodeFirehosePayload(data: Uint8Array): { seq: number; tInjectMs: number }`
  - `interface FirehoseTransportOptions { ratePerSec: number; payloadBytes?: number; tickMs?: number; maxBurstMultiple?: number }`
  - `class FirehoseTransport extends EventEmitter implements BleTransport { constructor(opts: FirehoseTransportOptions); stopEmitting(): void; get injected(): number; get saturatedTicks(): number; readonly writes: Uint8Array[] }`

- [ ] **Step 1: Write the failing test**

Create `tests/stress/firehose-transport.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  FirehoseTransport,
  encodeFirehosePayload,
  decodeFirehosePayload,
  FIREHOSE_HEADER_BYTES
} from './firehose-transport.js';

describe('firehose payload codec', () => {
  it('round-trips sequence number and injection timestamp', () => {
    const encoded = encodeFirehosePayload(123456, 987.6543, 20);
    expect(encoded).toHaveLength(20);
    const { seq, tInjectMs } = decodeFirehosePayload(encoded);
    expect(seq).toBe(123456);
    expect(tInjectMs).toBeCloseTo(987.6543, 10);
  });

  it('rejects a payload too small to carry the header', () => {
    expect(() => encodeFirehosePayload(0, 0, FIREHOSE_HEADER_BYTES - 1)).toThrow(RangeError);
    expect(() => decodeFirehosePayload(new Uint8Array(FIREHOSE_HEADER_BYTES - 1))).toThrow(RangeError);
  });

  it('decodes correctly from a byte-offset view, as JSON round-tripping produces', () => {
    const encoded = encodeFirehosePayload(7, 42.5, 16);
    const viaJson = Uint8Array.from(JSON.parse(JSON.stringify(Array.from(encoded))));
    expect(decodeFirehosePayload(viaJson)).toEqual({ seq: 7, tInjectMs: 42.5 });
  });
});

describe('FirehoseTransport', () => {
  it('reports a masked synthetic device, never a real identifier', async () => {
    const t = new FirehoseTransport({ ratePerSec: 10 });
    const device = await t.connect();
    expect(device).toEqual({ name: 'FirehoseDevice', id: 'firehose' });
    expect(t.isConnected()).toBe(true);
    await t.cleanup();
    expect(t.isConnected()).toBe(false);
  });

  it('emits monotonically increasing sequence numbers from zero', async () => {
    const t = new FirehoseTransport({ ratePerSec: 200 });
    const seqs: number[] = [];
    t.on('data', (d: Uint8Array) => seqs.push(decodeFirehosePayload(d).seq));
    await t.connect();
    await new Promise((r) => setTimeout(r, 200));
    await t.cleanup();

    expect(seqs.length).toBeGreaterThan(5);
    expect(seqs[0]).toBe(0);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1] + 1);
  });

  it('achieves the requested rate within 20% over a half-second window', async () => {
    const t = new FirehoseTransport({ ratePerSec: 100 });
    let count = 0;
    t.on('data', () => count++);
    await t.connect();
    await new Promise((r) => setTimeout(r, 500));
    await t.cleanup();

    expect(count).toBeGreaterThan(40);
    expect(count).toBeLessThan(75);
  });

  it('stops emitting after cleanup', async () => {
    const t = new FirehoseTransport({ ratePerSec: 500 });
    let count = 0;
    t.on('data', () => count++);
    await t.connect();
    await new Promise((r) => setTimeout(r, 100));
    await t.cleanup();
    const afterCleanup = count;
    await new Promise((r) => setTimeout(r, 100));
    expect(count).toBe(afterCleanup);
  });

  it('records writes without needing a device', async () => {
    const t = new FirehoseTransport({ ratePerSec: 1 });
    await t.connect();
    await t.write(new Uint8Array([0xa7, 0xb3]));
    expect(t.writes).toHaveLength(1);
    expect(Array.from(t.writes[0])).toEqual([0xa7, 0xb3]);
    await t.cleanup();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/stress/firehose-transport.test.ts`
Expected: FAIL — `Cannot find module './firehose-transport.js'`.

- [ ] **Step 3: Implement the transport**

Create `tests/stress/firehose-transport.ts`:

```typescript
import { EventEmitter } from 'events';
import type { BleTransport } from '../../src/ble-transport.js';

/** seq (uint32 LE) + injection timestamp (float64 LE). */
export const FIREHOSE_HEADER_BYTES = 12;
/** Filler byte for the remainder of the payload. */
export const FIREHOSE_FILLER = 0xa7;
/** Roughly a CS108 status notification; overridable per run. */
export const DEFAULT_PAYLOAD_BYTES = 20;

export function encodeFirehosePayload(seq: number, tInjectMs: number, payloadBytes: number): Uint8Array {
  if (payloadBytes < FIREHOSE_HEADER_BYTES) {
    throw new RangeError(`payloadBytes must be >= ${FIREHOSE_HEADER_BYTES}, got ${payloadBytes}`);
  }
  const buf = new Uint8Array(payloadBytes).fill(FIREHOSE_FILLER);
  const view = new DataView(buf.buffer);
  view.setUint32(0, seq, true);
  view.setFloat64(4, tInjectMs, true);
  return buf;
}

export function decodeFirehosePayload(data: Uint8Array): { seq: number; tInjectMs: number } {
  if (data.length < FIREHOSE_HEADER_BYTES) {
    throw new RangeError(`payload must be >= ${FIREHOSE_HEADER_BYTES} bytes, got ${data.length}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { seq: view.getUint32(0, true), tInjectMs: view.getFloat64(4, true) };
}

export interface FirehoseTransportOptions {
  /** Target notifications per second. */
  ratePerSec: number;
  /** Bytes per notification, including the 12-byte header. */
  payloadBytes?: number;
  /** Scheduler granularity. */
  tickMs?: number;
  /** Per-tick emission cap, as a multiple of the tick's nominal share. */
  maxBurstMultiple?: number;
}

/**
 * A BleTransport that synthesises notifications instead of receiving them.
 *
 * Scheduling is absolute rather than incremental: each tick computes how many
 * notifications SHOULD have been emitted by now and emits the difference, so a
 * late timer does not permanently shift the rate. The per-tick cap stops a long
 * stall from being repaid as one enormous burst; ticks that hit the cap are
 * counted, because a generator that cannot keep up is a shortfall in the
 * INSTRUMENT and must never be reported as bridge message loss.
 */
export class FirehoseTransport extends EventEmitter implements BleTransport {
  private readonly ratePerSec: number;
  private readonly payloadBytes: number;
  private readonly tickMs: number;
  private readonly maxBurst: number;

  private timer: NodeJS.Timeout | null = null;
  private connected = false;
  private startedAt = 0;
  private seq = 0;
  private saturated = 0;

  readonly writes: Uint8Array[] = [];

  constructor(opts: FirehoseTransportOptions) {
    super();
    if (opts.ratePerSec <= 0) throw new RangeError(`ratePerSec must be > 0, got ${opts.ratePerSec}`);
    this.ratePerSec = opts.ratePerSec;
    this.payloadBytes = opts.payloadBytes ?? DEFAULT_PAYLOAD_BYTES;
    this.tickMs = opts.tickMs ?? 1;
    const nominalPerTick = Math.ceil((this.ratePerSec * this.tickMs) / 1000);
    this.maxBurst = Math.max(1, nominalPerTick * (opts.maxBurstMultiple ?? 10));
    if (this.payloadBytes < FIREHOSE_HEADER_BYTES) {
      throw new RangeError(`payloadBytes must be >= ${FIREHOSE_HEADER_BYTES}, got ${this.payloadBytes}`);
    }
  }

  /** Notifications actually emitted so far. */
  get injected(): number { return this.seq; }
  /** Ticks where the per-tick cap was hit — instrument shortfall, not bridge loss. */
  get saturatedTicks(): number { return this.saturated; }

  async connect(): Promise<{ name: string; id: string }> {
    this.connected = true;
    this.startedAt = performance.now();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref();
    return { name: 'FirehoseDevice', id: 'firehose' };
  }

  private tick(): void {
    if (!this.connected) return;
    const due = Math.floor(((performance.now() - this.startedAt) * this.ratePerSec) / 1000);
    let budget = this.maxBurst;
    while (this.seq < due && budget > 0) {
      this.emit('data', encodeFirehosePayload(this.seq, performance.now(), this.payloadBytes));
      this.seq++;
      budget--;
    }
    if (this.seq < due) this.saturated++;
  }

  /** Stop generating without tearing the transport down, so in-flight messages can drain. */
  stopEmitting(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async write(data: Uint8Array): Promise<void> {
    this.writes.push(data);
  }

  async cleanup(): Promise<void> {
    this.stopEmitting();
    this.connected = false;
    this.emit('disconnect');
  }

  isConnected(): boolean { return this.connected; }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/stress/firehose-transport.test.ts`
Expected: PASS, 8 tests. The rate test is timing-based; if it is flaky on a loaded box, widen the bounds and say so in the commit message rather than deleting the assertion.

- [ ] **Step 5: Commit**

```bash
git add tests/stress/firehose-transport.ts tests/stress/firehose-transport.test.ts
git commit -m "test: add the injecting firehose transport

Synthesises notifications at a controlled rate with an absolute (drift-free)
scheduler. Each payload carries its sequence number and injection timestamp so
the consumer can compute loss and per-notification latency. Ticks that hit the
per-tick cap are counted separately: a generator that cannot keep up is an
instrument shortfall and must never be reported as bridge message loss.

Refs: TRA-1156"
```

---

### Task 4: The harness orchestrator

Wire the transport into a real bridge, consume the far end over a real WebSocket, and return one result object.

**Files:**
- Create: `tests/stress/firehose-harness.ts`
- Test: `tests/stress/firehose.test.ts`

**Interfaces:**
- Consumes: `BridgeServer` (Task 1), metrics (Task 2), `FirehoseTransport` + `decodeFirehosePayload` (Task 3).
- Produces:
  - `interface FirehoseRunOptions { ratePerSec: number; durationMs: number; payloadBytes?: number; warmupMs?: number; memorySampleMs?: number; drainMs?: number }`
  - `interface FirehoseResult { targetRatePerSec, achievedRatePerSec, durationMs, payloadBytes, injected, received, lost, missing, outOfOrder, saturatedTicks, latency: LatencySummary, memory: MemorySummary }`
  - `async function runFirehose(opts: FirehoseRunOptions): Promise<FirehoseResult>`

- [ ] **Step 1: Write the failing test**

Create `tests/stress/firehose.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/stress/firehose.test.ts`
Expected: FAIL — `Cannot find module './firehose-harness.js'`.

- [ ] **Step 3: Implement the harness**

Create `tests/stress/firehose-harness.ts`:

```typescript
import WebSocket from 'ws';
import { BridgeServer } from '../../src/bridge-server.js';
import { getPackageMetadata } from '../../src/utils.js';
import { FirehoseTransport, decodeFirehosePayload, DEFAULT_PAYLOAD_BYTES } from './firehose-transport.js';
import { LatencyRecorder, SequenceTracker, MemorySampler } from './metrics.js';
import type { LatencySummary, MemorySummary } from './metrics.js';

export interface FirehoseRunOptions {
  ratePerSec: number;
  durationMs: number;
  payloadBytes?: number;
  /** Latency samples before this point are discarded. Defaults to 10% of duration, capped at 1s. */
  warmupMs?: number;
  memorySampleMs?: number;
  /** Quiet period after generation stops, for in-flight messages to arrive. */
  drainMs?: number;
}

export interface FirehoseResult {
  targetRatePerSec: number;
  achievedRatePerSec: number;
  durationMs: number;
  payloadBytes: number;
  injected: number;
  received: number;
  /** injected - received. The headline "no message loss" figure. */
  lost: number;
  /** Sum of sequence-number gap sizes seen by the consumer. */
  missing: number;
  outOfOrder: number;
  saturatedTicks: number;
  latency: LatencySummary;
  memory: MemorySummary;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drive the current TypeScript bridge with synthetic notifications and measure
 * the relay.
 *
 * The measured path is transport 'data' event -> BleSession -> WebSocketHandler
 * -> JSON.stringify -> ws -> JSON.parse -> Uint8Array. Consumer-side
 * deserialisation is deliberately included: it is what the mock does, and a
 * comparison against the Python bridge is only valid if the SAME consumer is
 * used on both sides.
 *
 * Binds an OS-assigned ephemeral port on loopback. It must never touch 8080.
 */
export async function runFirehose(opts: FirehoseRunOptions): Promise<FirehoseResult> {
  const payloadBytes = opts.payloadBytes ?? DEFAULT_PAYLOAD_BYTES;
  const warmupMs = opts.warmupMs ?? Math.min(1000, Math.floor(opts.durationMs / 10));
  const memorySampleMs = opts.memorySampleMs ?? 250;
  const drainMs = opts.drainMs ?? 500;

  const latency = new LatencyRecorder(Math.ceil((opts.ratePerSec * opts.durationMs) / 1000) + 1024);
  const sequence = new SequenceTracker();
  const memory = new MemorySampler();

  let transport: FirehoseTransport | null = null;
  const server = new BridgeServer(undefined, undefined, () => {
    transport = new FirehoseTransport({ ratePerSec: opts.ratePerSec, payloadBytes });
    return transport;
  });

  const port = await server.start(0, '127.0.0.1');
  if (port === 8080) throw new Error('refusing to run: ephemeral bind returned 8080');

  const { version } = getPackageMetadata();
  const url = `ws://127.0.0.1:${port}/?service=9800&write=9900&notify=9901&_mv=${version}`;
  const ws = new WebSocket(url);

  let warmupEndsAt = Number.POSITIVE_INFINITY;

  ws.on('message', (raw: Buffer) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== 'data') return;
    const tRecvMs = performance.now();
    const { seq, tInjectMs } = decodeFirehosePayload(Uint8Array.from(msg.data as number[]));
    sequence.observe(seq);
    if (tInjectMs >= warmupEndsAt) latency.record(tRecvMs - tInjectMs);
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('error', reject);
    ws.on('message', function onFirst(raw: Buffer) {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'connected') { ws.off('message', onFirst); resolve(); }
      if (msg.type === 'error') { ws.off('message', onFirst); reject(new Error(msg.error)); }
    });
  });

  if (!transport) throw new Error('bridge never built a transport');
  const activeTransport: FirehoseTransport = transport;

  const startedAt = performance.now();
  warmupEndsAt = startedAt + warmupMs;

  const memoryTimer = setInterval(() => memory.sample(), memorySampleMs);
  memoryTimer.unref();
  memory.sample();

  await delay(opts.durationMs);

  activeTransport.stopEmitting();
  const elapsedMs = performance.now() - startedAt;
  clearInterval(memoryTimer);
  memory.sample();

  await delay(drainMs);

  ws.close();
  await server.stop();

  const injected = activeTransport.injected;
  const received = sequence.received;

  return {
    targetRatePerSec: opts.ratePerSec,
    achievedRatePerSec: (injected / elapsedMs) * 1000,
    durationMs: elapsedMs,
    payloadBytes,
    injected,
    received,
    lost: injected - received,
    missing: sequence.missing,
    outOfOrder: sequence.outOfOrder,
    saturatedTicks: activeTransport.saturatedTicks,
    latency: latency.summary(),
    memory: memory.summary()
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/stress/firehose.test.ts`
Expected: PASS, 3 tests. If `lost` is non-zero at 50 msg/s, that is a real finding — investigate before adjusting the assertion, and do not weaken it to get green.

- [ ] **Step 5: Confirm nothing bound port 8080**

Run: `ss -ltnp 2>/dev/null | grep ':8080' || echo 'nothing new on 8080'`
Expected: exactly one listener, the pre-existing `rust-ble-test` process owned by the peer agent. The harness must not appear.

- [ ] **Step 6: Run the full non-hardware suite and both typechecks**

Run: `pnpm exec tsc --noEmit && pnpm run typecheck:tests && pnpm exec vitest run tests/unit tests/stress`
Expected: all pass. Report the actual counts.

- [ ] **Step 7: Commit**

```bash
git add tests/stress/firehose-harness.ts tests/stress/firehose.test.ts
git commit -m "test: add the firehose harness and its functional tests

Drives a real BridgeServer on an ephemeral loopback port with the injecting
transport, consumes the far end over a real WebSocket, and reports loss,
latency percentiles and heap growth. Consumer-side JSON deserialisation is
included in the measured path deliberately: it is what the mock does, and a
Python-bridge comparison is only valid against the same consumer.

Tests run at 50 msg/s to stay below the noise floor of a hardware soak running
on the same host; the sustained ladder is opt-in and lands separately.

Refs: TRA-1156"
```

---

### Task 5: The sustained baseline runner

The rate ladder that produces the actual deliverable. Opt-in, because it saturates a shared box.

**Files:**
- Create: `tests/stress/firehose-baseline.test.ts`
- Modify: `package.json` (add `stress:firehose` script)

**Interfaces:**
- Consumes: `runFirehose` and `FirehoseResult` (Task 4).
- Produces: JSON at `tmp/firehose/<label>.json` (already gitignored via `tmp/`), and a printed summary table.

- [ ] **Step 1: Write the runner**

There is no failing-test-first cycle here: this file IS a test, and its subject — `runFirehose` — is already covered by Task 4. Create `tests/stress/firehose-baseline.test.ts`:

```typescript
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
```

- [ ] **Step 2: Add the script**

Add to `package.json` scripts, after `test:stress`:

```json
    "stress:firehose": "FIREHOSE_BASELINE=1 vitest run tests/stress/firehose-baseline.test.ts",
```

- [ ] **Step 3: Verify it is skipped by default**

Run: `pnpm exec vitest run tests/stress/firehose-baseline.test.ts`
Expected: 1 test skipped, 0 run. This proves `pnpm test:stress` stays fast and cannot accidentally saturate a shared box.

- [ ] **Step 4: Verify the ladder mechanism end to end, cheaply**

This exercises the write path and the ladder loop without a sustained run — two seconds at a low rate. It is NOT the baseline.

Run: `FIREHOSE_BASELINE=1 FIREHOSE_RATES=50 FIREHOSE_SECONDS=2 FIREHOSE_LABEL=smoke pnpm exec vitest run tests/stress/firehose-baseline.test.ts`
Expected: PASS; `tmp/firehose/smoke.json` written; the printed row shows `lost` 0.

Then: `cat tmp/firehose/smoke.json | head -30` to confirm the shape is what the results doc will consume.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm exec tsc --noEmit && pnpm run typecheck:tests
git add tests/stress/firehose-baseline.test.ts package.json
git commit -m "test: add the opt-in sustained firehose rate ladder

Gated behind FIREHOSE_BASELINE=1 so pnpm test:stress cannot saturate a shared
box by accident. Writes tmp/firehose/<label>.json for comparison against the
Python bridge.

Refs: TRA-1156"
```

---

### Task 6: Record the baseline, or record why it is missing

The ticket's acceptance is data, not code. This task produces the results document — and if the sustained ladder has not been run on a quiet box, it says exactly that rather than publishing numbers taken under contention.

**Files:**
- Create: `docs/design/2026-08-23-firehose-baseline.md`
- Modify: `docs/design/2026-08-23-bleak-esphome-notify-audit.md` (only if the ladder actually ran)

**Interfaces:**
- Consumes: `tmp/firehose/<label>.json` from Task 5.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Check whether the box is quiet**

Run: `uptime && ss -tnp state established '( sport = :8080 or dport = :8080 )' 2>/dev/null | tail -n +2 | wc -l`
Expected: load average low, and zero established connections on 8080 — meaning the peer agent's soak is not mid-run.

If either check fails, the ladder does NOT run. Go to Step 3.

- [ ] **Step 2: Run the ladder (only if Step 1 was clean AND the peer agent has confirmed the box is free)**

Run: `FIREHOSE_BASELINE=1 FIREHOSE_SECONDS=60 FIREHOSE_LABEL=ts-bridge-mssb pnpm run stress:firehose`
Expected: four rows (450/900/2250/4500 msg/s), `lost` 0 on every row, `tmp/firehose/ts-bridge-mssb.json` written.

- [ ] **Step 3: Write the results document**

Create `docs/design/2026-08-23-firehose-baseline.md` with these sections, filled from the actual JSON if Step 2 ran:

- **Status** — either the recorded baseline, or `BLOCKED: not yet recorded` with the reason (shared box under a hardware soak; see TRA-1167) stated in the first line.
- **What is measured** — the exact path: `transport 'data' → BleSession → WebSocketHandler → JSON.stringify → ws → JSON.parse → Uint8Array`. State plainly that consumer-side deserialisation is included and that a Python comparison is only valid against this same consumer.
- **What is NOT measured** — the real BLE/ESPHome ingress. The injection point IS the transport, so nothing upstream of `BleSession` is exercised. This baseline therefore bounds the relay, not the whole stack.
- **Method** — rates, duration, payload size, warmup, host, Node version, and the quiet-box condition.
- **Results table** — target rate, achieved rate, injected, received, lost, p50/p99/max ms, heap growth MB, saturated ticks.
- **Reading the saturated-ticks column** — a non-zero value means the generator, not the bridge, was the limit. Any row with saturated ticks bounds the instrument, not the subject.

- [ ] **Step 4: Update the notify audit only if the ladder ran**

If and only if Step 2 produced data, replace the `[inferred]` sentence in `docs/design/2026-08-23-bleak-esphome-notify-audit.md:82-84` with the measured result and a link to the new doc. If the ladder did not run, leave the audit untouched — the claim is still inferred, and marking it settled would be exactly the false optimism the repo's own rules forbid.

- [ ] **Step 5: Commit**

```bash
git add docs/design/2026-08-23-firehose-baseline.md
git commit -m "docs: record the firehose baseline method and results

Refs: TRA-1156"
```

---

## Self-Review

**Spec coverage.**

| Acceptance criterion | Task |
|---|---|
| sustained run at a stated multiple of 45 msg/s with no message loss | Task 5 (ladder, asserts `lost === 0`), Task 6 (execution) |
| no unbounded memory growth | Task 2 (`MemorySampler`), Task 4 (sampled per run), Task 6 (reported) |
| recorded p50/p99 per-notification latency | Task 2 (`LatencyRecorder`), Task 4 (`latency` in result), Task 6 (reported) |
| runs against the *current* stack | Task 1 — a real `BridgeServer`, real `WebSocketHandler`, real `ws`. Only the device is synthetic. |
| field-free, no hardware, no reader | Task 3 — the transport is the injection point; nothing below it exists |
| 10–100× of 45 msg/s | Task 5 — default ladder 450/900/2250/4500 = 10×/20×/50×/100× |
| leaves a regression net | Task 4 — `tests/stress/firehose.test.ts` runs in `pnpm test:stress` |

**Known gap, deliberate.** The acceptance criteria that are *data* (sustained run, p50/p99) can only be honestly satisfied on a quiet machine. A peer agent owns this box for a timing-sensitive hardware soak, and a baseline recorded under its load would be a number that reads as data and isn't. Task 6 Step 1 gates on this and Step 3 records the block explicitly rather than publishing a contaminated figure. If the ladder cannot run before the PR, the PR is a **draft** and the ticket carries the blocker — csw:work Step 9.

**Placeholder scan.** No TBDs. Every code step carries the actual code. Task 6 is prose-shaped by nature (it writes a document from measured values that do not exist yet), so it specifies the required sections and the exact decision rule for each, rather than inventing numbers.

**Type consistency.** `BleTransport` / `TransportFactory` (Task 1) are consumed by name in Tasks 3 and 4. `LatencySummary` / `MemorySummary` (Task 2) appear in `FirehoseResult` (Task 4). `stopEmitting()`, `injected`, `saturatedTicks` (Task 3) are called in Task 4. `runFirehose` / `FirehoseResult` (Task 4) are imported in Task 5. `DEFAULT_PAYLOAD_BYTES` is exported by Task 3 and imported by Task 4.
