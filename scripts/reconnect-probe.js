#!/usr/bin/env node
/**
 * Reconnect-floor probe — how fast can a client come back after releasing?
 *
 * TRA-1153 item 6 needs to cut `MOCK_CONFIG`'s retry budget on evidence, the way
 * `postDisconnectDelay` was cut 1100 -> 250 on 997 measured cycles. This is the
 * instrument for that. It answers ONE question:
 *
 *     after a clean disconnect, how soon may the next connect be ATTEMPTED
 *     before the bridge refuses it, and how often?
 *
 * ## Why a full-suite soak is the wrong instrument, measured rather than argued
 *
 * The platform session extracted release -> next-connect timing from 60 real
 * cycles of its integration suite:
 *
 *     min 791ms   median 3083ms   p95 7625ms   max 8462ms
 *
 * That looks like recovery data and is not. `min 791ms` is the tell: the client
 * never ATTEMPTED sooner, because its harness carries a 1s cooldown and vitest
 * adds inter-file startup on top. So the distribution describes HOW LONG THE
 * CLIENT WAITED, not how long the bridge needed, and it cannot say whether a
 * connect at 100ms would have succeeded. Harvesting connect cycles as a side
 * effect of running eight spec files measures the harness.
 *
 * This probe removes the client's patience from the measurement: it reconnects
 * IMMEDIATELY, and sweeps a ladder of deliberate delays so the output is a curve
 * with a floor in it rather than one number.
 *
 * ## It deliberately does NOT use the mock
 *
 * `MockBluetooth` retries a busy bridge up to `maxConnectRetries` times with
 * backoff -- which is the very thing being measured. Driving this through the
 * mock would measure the retry budget against itself and report success at
 * every rung. So the probe opens a bare WebSocket and treats the FIRST attempt
 * as the trial: the bridge's floor is what sets an honest budget above it.
 *
 * Usage:
 *   BLE_MCP_WS_URL=ws://127.0.0.1:25153 node scripts/reconnect-probe.js \
 *     --cycles 40 --label floor-1 [--ladder 0,50,100,250,500,1000,1200]
 */

import WebSocket from 'ws';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const BASE_URL = process.env.BLE_MCP_WS_URL;
if (!BASE_URL) {
  // No literal fallback. A probe that silently measured whatever answered a
  // guessed port would produce a confident curve about the wrong process --
  // CLAUDE.md's second failure class, in the one tool whose whole output is a
  // number someone will act on.
  throw new Error('BLE_MCP_WS_URL is not set. The bridge has no default port, so there is nothing to guess.');
}

const SERVICE = requireEnv('BLE_MCP_SERVICE_UUID');
const WRITE = requireEnv('BLE_MCP_WRITE_UUID');
const NOTIFY = requireEnv('BLE_MCP_NOTIFY_UUID');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. This repo is device-agnostic; there is no default UUID.`);
  return v;
}

const CYCLES = parseInt(getArg('cycles', '40'), 10);
const LABEL = getArg('label', 'unlabeled');
const LADDER = getArg('ladder', '0,50,100,250,500,1000,1200').split(',').map(Number);
/** Generous: we are timing the bridge, and a rung that needs 8s should show as 8s, not as a timeout. */
const CONNECT_TIMEOUT_MS = 15000;
const SESSION = `reconnect-probe-${process.pid}`;

function url() {
  const u = new URL(BASE_URL);
  u.searchParams.set('service', SERVICE);
  u.searchParams.set('write', WRITE);
  u.searchParams.set('notify', NOTIFY);
  u.searchParams.set('session', SESSION);
  return u.toString();
}

/**
 * One connect attempt, from socket construction to the bridge's `connected`.
 *
 * `connected` is the success condition, NOT the socket opening. The socket opens
 * before the BLE link exists, so timing to `open` would measure the WebSocket
 * handshake and report a floor far below the real one -- exactly the kind of
 * waiter/emitter mismatch this codebase keeps producing.
 */
function attempt() {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const ws = new WebSocket(url());

    const done = (outcome, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ outcome, detail, ms: Date.now() - startedAt, ws });
    };

    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* already gone */ }
      done('timeout', `no 'connected' within ${CONNECT_TIMEOUT_MS}ms`);
    }, CONNECT_TIMEOUT_MS);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'connected') done('connected', null);
      // `Device is busy` is the refusal this probe exists to find the edge of.
      else if (msg.type === 'error') done('refused', String(msg.error ?? '').slice(0, 120));
    });

    ws.on('error', (e) => done('ws_error', String(e.message ?? e).slice(0, 120)));
    ws.on('close', () => done('closed', 'socket closed before connected'));
  });
}

/** Close and WAIT for it. Returning before the close is processed is what makes the next connect race. */
function closeAndAwait(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', resolve);
    try { ws.close(); } catch { resolve(); }
    setTimeout(resolve, 3000); // never hang the probe on a socket that will not die
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function summarise(samples) {
  const ok = samples.filter((s) => s.outcome === 'connected').map((s) => s.ms).sort((a, b) => a - b);
  const pick = (p) => (ok.length ? ok[Math.min(ok.length - 1, Math.floor((p / 100) * ok.length))] : null);
  // Keyed by outcome AND detail. "refused" alone cannot distinguish `Device is
  // busy` -- the release race this probe exists to find -- from an unrelated
  // error, and collapsing them would let a real fault masquerade as contention.
  const failures = {};
  for (const s of samples) {
    if (s.outcome === 'connected') continue;
    const key = s.detail ? `${s.outcome}: ${s.detail}` : s.outcome;
    failures[key] = (failures[key] ?? 0) + 1;
  }
  return {
    n: samples.length,
    connected: ok.length,
    failureRate: samples.length ? +(1 - ok.length / samples.length).toFixed(4) : null,
    failures,
    median: pick(50),
    p95: pick(95),
    p99: pick(99),
    max: ok.length ? ok[ok.length - 1] : null
  };
}

async function main() {
  console.log(`[probe] ${LABEL}: ${CYCLES} cycles per rung, ladder ${LADDER.join(', ')}ms`);
  console.log(`[probe] session ${SESSION}`);
  console.log('[probe] measuring the BRIDGE, not the mock: one bare attempt per cycle, no retries.\n');

  const results = {};

  for (const delay of LADDER) {
    const samples = [];
    for (let i = 0; i < CYCLES; i++) {
      const r = await attempt();
      samples.push({ outcome: r.outcome, ms: r.ms, detail: r.detail });
      await closeAndAwait(r.ws);
      await sleep(delay);
    }
    const s = summarise(samples);
    results[delay] = s;
    const fail = s.failures && Object.keys(s.failures).length
      ? `  failures: ${JSON.stringify(s.failures)}`
      : '';
    console.log(
      `  delay ${String(delay).padStart(5)}ms  ->  connected ${s.connected}/${s.n}` +
      `  rate ${((1 - s.failureRate) * 100).toFixed(1)}%  median ${s.median}ms  p95 ${s.p95}ms  max ${s.max}ms${fail}`
    );
  }

  const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'tmp', 'probe');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${LABEL}.json`);
  writeFileSync(out, JSON.stringify({ label: LABEL, cyclesPerRung: CYCLES, ladder: LADDER, results }, null, 2));

  console.log(`\n[probe] written to ${out}`);
  console.log('[probe] The FLOOR is the lowest rung with a 100% rate. A retry budget');
  console.log('[probe] should clear it with margin, stated against the worst observed.');
}

main().catch((e) => {
  console.error('[probe] failed:', e.message);
  process.exit(1);
});
