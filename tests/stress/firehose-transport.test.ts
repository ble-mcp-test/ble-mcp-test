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
