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
