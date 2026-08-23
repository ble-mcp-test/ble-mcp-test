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
