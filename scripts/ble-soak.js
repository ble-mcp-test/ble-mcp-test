#!/usr/bin/env node
/**
 * BLE Soak Test — adapter stability comparison harness
 *
 * Drives sustained request/response traffic through the bridge's WebSocket and
 * records the things that distinguish a stable adapter from an unstable one:
 * panics, subprocess restarts, BLE link drops, response failures, latency.
 *
 * Usage:
 *   node scripts/ble-soak.js --minutes 15 --label hci0-asus [--interval 1000]
 *
 * Results are written to tmp/soak/<label>.json plus a printed summary.
 */

import WebSocket from 'ws';
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from 'fs';
import path from 'path';

// ---------------------------------------------------------------- config

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const MINUTES = parseFloat(getArg('minutes', '15'));
const LABEL = getArg('label', 'unlabeled');
const INTERVAL_MS = parseInt(getArg('interval', '1000'), 10);
const WS_URL = process.env.BLE_MCP_WS_URL;
if (!WS_URL) {
  // No literal fallback: the soak would otherwise connect to whatever happens to
  // be on the guessed port and report on it for hours.
  throw new Error('BLE_MCP_WS_URL is not set. The bridge has no default port.');
}
const CMD_TIMEOUT_MS = 5000;
const DEVICE_MAC = '6C:79:B8:XX:XX:XX';

// Load mode: 'poll' = 1 req/interval trigger-status; 'inventory' = continuous RFID stream
const MODE = getArg('mode', 'poll');

// Trigger-status query — canonical test command from tests/shared/device-commands.ts
const TEST_COMMAND = [0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x01];
const BATTERY_COMMAND = [0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00];
const isValidResponse = (d) =>
  d.length === 11 && d[0] === 0xA7 && d[1] === 0xB3 &&
  d[8] === 0xA0 && d[9] === 0x01 && d[10] === 0x00;

/** Any A0-class status reply (battery 0xA000 or trigger 0xA001) — used in thrash mode. */
const isStatusReply = (d) => d.length >= 10 && d[0] === 0xA7 && d[1] === 0xB3 && d[8] === 0xA0;

/**
 * RFID inventory control. Byte sequences recovered from production logs
 * (logs/out__2026-08-20_*.log) rather than re-derived from the CS108 protocol:
 *   START = write 0x0F (START_INVENTORY) to register 0xF000
 *   ABORT = 0x40 0x03 control command, matching CS108 spec Appendix A.8
 * Both carry event code 0x8002 (RFID_FIRMWARE_COMMAND) at bytes 8-9.
 */
const RFID_START_INVENTORY =
  [0xA7, 0xB3, 0x0A, 0xC2, 0x82, 0x37, 0x00, 0x00, 0x80, 0x02, 0x70, 0x01, 0x00, 0xF0, 0x0F, 0x00, 0x00, 0x00];
const RFID_ABORT =
  [0xA7, 0xB3, 0x0A, 0xC2, 0x82, 0x37, 0x00, 0x00, 0x80, 0x02, 0x40, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

/**
 * Inventory tag = RFID uplink (0x8100 at bytes 8-9) whose R2000 packet type
 * (bytes 12-13, LE) is INVENTORY (0x0005). Cycle-end diagnostics (0x000E) and
 * command begin/end packets share 0x8100 and must not count as tags.
 */
const isInventoryTag = (d) =>
  d.length >= 14 && d[8] === 0x81 && d[9] === 0x00 &&
  d[12] === 0x05 && (d[13] & 0x7f) === 0x00; // 0x0005 normal or 0x8005 compact (top bit)

/**
 * Bring-up sequence for unfiltered INVENTORY (all tags in field).
 * Derived from trakrf platform's tests/integration/ble-mcp-test/sequence.spec.ts,
 * with the TAGMSK_* descriptor block and mask-enable INV_CFG omitted — those are
 * LOCATE-mode settings that filter down to a single tag.
 */
const INVENTORY_BRINGUP = [
  { desc: 'RFID_POWER_ON',
    data: [0xa7, 0xb3, 0x02, 0xc2, 0x82, 0x37, 0x00, 0x00, 0x80, 0x00], delay: 800 },
  { desc: 'ANT_PORT_DWELL = 0 (continuous)',
    data: [0xa7, 0xb3, 0x0a, 0xc2, 0x82, 0x37, 0x00, 0x00, 0x80, 0x02, 0x70, 0x01, 0x05, 0x07, 0x00, 0x00, 0x00, 0x00] },
  { desc: 'ANT_PORT_POWER = 30 dBm',
    data: [0xa7, 0xb3, 0x0a, 0xc2, 0x82, 0x37, 0x00, 0x00, 0x80, 0x02, 0x70, 0x01, 0x06, 0x07, 0x2c, 0x01, 0x00, 0x00] },
  { desc: 'QUERY_CFG = 0x0180',
    data: [0xa7, 0xb3, 0x0a, 0xc2, 0x82, 0x37, 0x00, 0x00, 0x80, 0x02, 0x70, 0x01, 0x00, 0x09, 0x80, 0x01, 0x00, 0x00] },
  { desc: 'INV_SEL = FIXED_Q',
    data: [0xa7, 0xb3, 0x0a, 0xc2, 0x82, 0x37, 0x00, 0x00, 0x80, 0x02, 0x70, 0x01, 0x02, 0x09, 0x00, 0x00, 0x00, 0x00] },
  { desc: 'INV_ALG_PARM_0 = 0',
    data: [0xa7, 0xb3, 0x0a, 0xc2, 0x82, 0x37, 0x00, 0x00, 0x80, 0x02, 0x70, 0x01, 0x03, 0x09, 0x00, 0x00, 0x00, 0x00] },
  { desc: 'INV_ALG_PARM_2 = 0',
    data: [0xa7, 0xb3, 0x0a, 0xc2, 0x82, 0x37, 0x00, 0x00, 0x80, 0x02, 0x70, 0x01, 0x05, 0x09, 0x00, 0x00, 0x00, 0x00] },
  { desc: 'HST_CMD = START_INVENTORY (0x0F)',
    data: RFID_START_INVENTORY, delay: 500 },
];

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'tmp', 'soak');

// Where the bridge's stderr is captured, if anything is capturing it. pm2 used
// to write this and no longer exists; a bridge started by hand writes to a
// terminal and this file will be absent, in which case panics are UNOBSERVABLE
// rather than absent. Point it at a real capture with BLE_MCP_ERR_LOG.
const ERR_LOG = process.env.BLE_MCP_ERR_LOG || path.join(PROJECT_ROOT, 'logs', 'err.log');
const WS_PORT = new URL(WS_URL).port || '80';

// ---------------------------------------------------------------- probes

const sh = (cmd) => {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};

/** Which adapter currently holds the link to the device, if any. */
function linkState() {
  for (const hci of ['hci0', 'hci1']) {
    const out = sh(`sudo -n hcitool -i ${hci} con 2>/dev/null`);
    if (out.includes(DEVICE_MAC)) return hci;
  }
  return null;
}

/**
 * Count of Rust panics captured so far, or null if nothing is capturing stderr.
 *
 * Returning null rather than 0 is the whole point. A soak that cannot observe
 * panics and one that observed none both used to report 0, so the summary said
 * "no panics" either way -- a health signal that is inert reads exactly like a
 * healthy system.
 */
function panicCount() {
  if (!existsSync(ERR_LOG)) return null;
  try {
    return (readFileSync(ERR_LOG, 'utf8').match(/panicked at/g) || []).length;
  } catch { return null; }
}

/**
 * Identity of whatever is listening on the soak's WebSocket port, or null.
 *
 * This replaces asking pm2 for a restart count. The bridge is not supervised
 * any more -- it is started by hand and orphaned to init -- so there is no
 * supervisor to ask, and the replatform ships no supervision at all. Process
 * identity works regardless of who launched it.
 *
 * Matched on the SOCKET, not on a command-line pattern: `pgrep -f rust-ble-test`
 * also matches the shell running the pipeline, so it reports a bridge that is
 * not there. Start time is folded in because PIDs are reused.
 */
function bridgeIdentity() {
  const out = sh(`ss -ltnpH "sport = :${WS_PORT}"`);
  const pid = out.match(/pid=(\d+)/)?.[1];
  if (!pid) return null;
  const since = sh(`ps -o lstart= -p ${pid}`);
  return since ? `${pid}@${since}` : null;
}

/** b - a, or null if either end could not be observed. */
function delta(a, b) {
  return a === null || a === undefined || b === null || b === undefined ? null : b - a;
}

function adapterInventory() {
  const out = sh('hciconfig');
  return out.split('\n').filter((l) => /^hci\d/.test(l)).map((l) => l.split(':')[0]);
}

// ---------------------------------------------------------------- state

const started = Date.now();
const endAt = started + MINUTES * 60 * 1000;

const stats = {
  label: LABEL,
  mode: MODE,
  startedAt: new Date(started).toISOString(),
  durationMin: MINUTES,
  intervalMs: INTERVAL_MS,
  tagNotifications: 0,
  bytesIn: 0,
  streamGaps: 0,          // inventory: gaps > 2s in the tag stream
  bringupOk: null,
  wsUrl: WS_URL,
  adaptersPresent: adapterInventory(),
  linkAdapterAtStart: linkState(),
  sent: 0,
  responses: 0,
  valid: 0,
  timeouts: 0,
  latencies: [],
  wsOpens: 0,
  wsCloses: 0,
  wsErrors: 0,
  linkDrops: 0,
  linkAdapterChanges: [],
  panicsAtStart: panicCount(),
  panicsAtEnd: null,
  bridgeIdentityAtStart: bridgeIdentity(),
  bridgeIdentityAtEnd: null,
  /** Times the process on the WS port changed identity mid-soak. */
  bridgeRestarts: 0,
  /** Samples where nothing was listening on the WS port at all. */
  bridgeAbsentSamples: 0,
  longestSilenceMs: 0,
  events: [],
};

const logEvent = (type, detail) => {
  const e = { t: new Date().toISOString(), elapsedS: Math.round((Date.now() - started) / 1000), type, detail };
  stats.events.push(e);
  console.log(`  [${e.elapsedS}s] ${type}${detail ? ': ' + detail : ''}`);
};

let ws = null;
let pending = null;          // { resolve, timer, sentAt }
let lastResponseAt = Date.now();
let stopping = false;
let lastLinkAdapter = stats.linkAdapterAtStart;

// ---------------------------------------------------------------- ws

function connect() {
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    stats.wsOpens++;
    logEvent('ws_open');
    if (MODE === 'inventory') startInventory();
    if (MODE === 'recover' && !recoveryStarted) { recoveryStarted = true; runRecoveryCycles(); }
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== 'data' || !Array.isArray(msg.data)) return;

    const data = Uint8Array.from(msg.data);
    lastResponseAt = Date.now();
    stats.bytesIn += data.length;

    if (isInventoryTag(data)) {
      stats.tagNotifications++;
      return;
    }

    if (MODE === 'thrash') {
      if (isStatusReply(data)) stats.responses++;
      return;
    }

    if (pending && isValidResponse(data)) {
      clearTimeout(pending.timer);
      stats.responses++;
      stats.valid++;
      stats.latencies.push(Date.now() - pending.sentAt);
      pending = null;
    } else if (isValidResponse(data)) {
      stats.responses++;   // valid shape but nothing waiting (late arrival)
    }
  });

  ws.on('close', () => {
    stats.wsCloses++;
    logEvent('ws_close');
    if (!stopping) setTimeout(connect, 1000);
  });

  ws.on('error', (err) => {
    stats.wsErrors++;
    logEvent('ws_error', err.message);
  });
}

const rawSend = (bytes) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify({ type: 'data', data: Array.from(bytes) })); return true; }
  catch (err) { logEvent('send_error', err.message); return false; }
};

/** Run the inventory bring-up sequence, then let tags stream continuously. */
async function startInventory() {
  logEvent('inventory_bringup_start');
  for (const step of INVENTORY_BRINGUP) {
    if (!rawSend(step.data)) {
      stats.bringupOk = false;
      logEvent('inventory_bringup_failed', step.desc);
      return;
    }
    await new Promise((r) => setTimeout(r, step.delay || 150));
  }
  stats.bringupOk = true;
  logEvent('inventory_bringup_done');
}

function stopInventory() {
  // Both known stop forms — HST_CMD=0 and the spec ABORT control command.
  rawSend([0xa7, 0xb3, 0x0a, 0xc2, 0x82, 0x37, 0x00, 0x00, 0x80, 0x02, 0x70, 0x01, 0x00, 0xf0, 0x00, 0x00, 0x00, 0x00]);
  rawSend(RFID_ABORT);
}

/**
 * Thrash mode: fire writes as fast as the interval allows WITHOUT waiting for a
 * response. Targets the write path and the Rust bridge's single serialized command
 * task + unbounded mpsc queue, rather than the notification path.
 */
let recoveryStarted = false;
let thrashToggle = false;
function thrashCommand() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  thrashToggle = !thrashToggle;
  const cmd = thrashToggle ? TEST_COMMAND : BATTERY_COMMAND;
  if (rawSend(cmd)) stats.sent++;
}

function sendCommand() {
  if (MODE === 'inventory') return;   // inventory streams on its own
  if (MODE === 'recover') return;     // recovery cycles drive their own probes
  if (MODE === 'thrash') return thrashCommand();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (pending) return;   // still awaiting previous response

  const sentAt = Date.now();
  stats.sent++;
  pending = {
    sentAt,
    timer: setTimeout(() => {
      stats.timeouts++;
      logEvent('cmd_timeout');
      pending = null;
    }, CMD_TIMEOUT_MS),
  };

  try {
    ws.send(JSON.stringify({ type: 'data', data: TEST_COMMAND }));
  } catch (err) {
    clearTimeout(pending.timer);
    pending = null;
    logEvent('send_error', err.message);
  }
}

// ------------------------------------------------------- disconnect recovery

const CYCLES = parseInt(getArg('cycles', '10'), 10);
const RECOVERY_TIMEOUT_MS = parseInt(getArg('recovery-timeout', '90000'), 10);

/** Current LE connection handle for the device, or null. */
function linkHandle() {
  for (const hci of ['hci0', 'hci1']) {
    const out = sh(`sudo -n hcitool -i ${hci} con 2>/dev/null`);
    const m = out.match(new RegExp(`${DEVICE_MAC}\\s+handle\\s+(\\d+)`, 'i'));
    if (m) return { hci, handle: m[1] };
  }
  return null;
}


/** Poll until the device link exists (returns {hci,handle}) or timeout. */
async function waitForLink(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping) {
    const l = linkHandle();
    if (l) return l;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/** Poll until the device link is gone, or timeout. */
async function waitForNoLink(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping) {
    if (!linkHandle()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Wait until a valid device response arrives, or timeout. */
function awaitHealthy(timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const probe = setInterval(() => {
      if (Date.now() > deadline) { clearInterval(probe); return resolve(false); }
      if (ws && ws.readyState === WebSocket.OPEN) rawSend(TEST_COMMAND);
    }, 1000);

    const startCount = stats.valid + stats.responses;
    const check = setInterval(() => {
      if (stats.valid + stats.responses > startCount) {
        clearInterval(probe); clearInterval(check); resolve(true);
      } else if (Date.now() > deadline) {
        clearInterval(probe); clearInterval(check); resolve(false);
      }
    }, 100);
  });
}

/**
 * Induce a real BLE link drop with an HCI Disconnect and measure whether — and how
 * fast — the bridge comes back. This is the direct test of §5: the device stays
 * powered and advertising, so a healthy bridge should reconnect on its own.
 */
async function runRecoveryCycles() {
  stats.cycles = [];
  logEvent('recovery_test_start', `${CYCLES} cycles`);

  // Wait for initial health before starting.
  if (!(await awaitHealthy(60000))) {
    logEvent('recovery_abort', 'never became healthy at start');
    return finish();
  }
  logEvent('baseline_healthy');

  for (let i = 1; i <= CYCLES && !stopping; i++) {
    // Wait for the link to be genuinely re-established before the next induction,
    // otherwise fast cycles measure leftover state instead of a real recovery.
    const link = await waitForLink(45000);
    if (!link) {
      logEvent('cycle_skip', `#${i}: link never re-established within 45s`);
      stats.cycles.push({ cycle: i, induced: false, recovered: false });
      continue;
    }
    await new Promise((r) => setTimeout(r, 2000));   // let traffic settle on the fresh link

    const pBefore = panicCount();
    const idBefore = bridgeIdentity();
    logEvent('inducing_disconnect', `#${i} on ${link.hci} handle ${link.handle}`);
    sh(`sudo -n hcitool -i ${link.hci} ledc ${link.handle}`);

    const t0 = Date.now();
    // Confirm the link actually dropped, so we measure a real recovery.
    const dropConfirmed = await waitForNoLink(8000);
    if (!dropConfirmed) logEvent('drop_unconfirmed', `#${i}: link still present after ledc`);

    const relinked = await waitForLink(RECOVERY_TIMEOUT_MS);
    const recovered = relinked ? await awaitHealthy(20000) : false;
    const ms = Date.now() - t0;

    const rec = {
      cycle: i,
      induced: true,
      adapter: link.hci,
      dropConfirmed,
      recovered,
      recoveryMs: recovered ? ms : null,
      panics: delta(pBefore, panicCount()),
      bridgeRestarted: idBefore === null ? null : bridgeIdentity() !== idBefore,
    };
    stats.cycles.push(rec);
    logEvent(recovered ? 'recovered' : 'RECOVERY_FAILED',
      `#${i} in ${(ms / 1000).toFixed(1)}s, panics=${rec.panics ?? 'unobservable'}, ` +
      `bridge restarted=${rec.bridgeRestarted ?? 'unobservable'}`);

    if (!recovered) {
      // Bridge is wedged. Give the supervisor a chance, then continue measuring.
      logEvent('wedged', 'attempting to continue');
    }
  }

  finish();
}

// ---------------------------------------------------------------- loops

const cmdTimer = setInterval(sendCommand, INTERVAL_MS);

let inGap = false;
const monitorTimer = setInterval(() => {
  const silence = Date.now() - lastResponseAt;
  if (silence > stats.longestSilenceMs) stats.longestSilenceMs = silence;

  // Inventory should stream continuously; >2s of silence is a stall.
  if (MODE === 'inventory' && stats.bringupOk) {
    if (silence > 2000 && !inGap) { inGap = true; stats.streamGaps++; logEvent('stream_gap', `${Math.round(silence / 1000)}s of silence`); }
    else if (silence <= 2000) inGap = false;
  }

  const link = linkState();
  if (link !== lastLinkAdapter) {
    if (lastLinkAdapter && !link) { stats.linkDrops++; logEvent('link_drop', `was on ${lastLinkAdapter}`); }
    else if (link) logEvent('link_up', `on ${link}`);
    stats.linkAdapterChanges.push({ elapsedS: Math.round((Date.now() - started) / 1000), from: lastLinkAdapter, to: link });
    lastLinkAdapter = link;
  }

  const panics = panicCount();
  if (panics !== null && panics > (stats._lastPanics ?? stats.panicsAtStart ?? 0)) {
    logEvent('rust_panic', `total ${panics}`);
  }
  if (panics !== null) stats._lastPanics = panics;

  // Watch the process on the WS port. A restart between two endpoint samples
  // would otherwise be invisible: the bridge dies, something restarts it, and
  // start and end identities happen to differ by nothing observable.
  const id = bridgeIdentity();
  if (id === null) {
    stats.bridgeAbsentSamples++;
    if (stats._lastBridgeId !== null) logEvent('bridge_absent', 'nothing listening on the WS port');
  } else if (stats._lastBridgeId && id !== stats._lastBridgeId) {
    stats.bridgeRestarts++;
    logEvent('bridge_restart', `${stats._lastBridgeId} -> ${id}`);
  }
  stats._lastBridgeId = id;
}, 2000);

const progressTimer = setInterval(() => {
  const elapsed = Math.round((Date.now() - started) / 1000);
  const remain = Math.max(0, Math.round((endAt - Date.now()) / 1000));
  const load = MODE === 'inventory'
    ? `tags=${stats.tagNotifications} (${(stats.tagNotifications / Math.max(1, elapsed)).toFixed(1)}/s) gaps=${stats.streamGaps}`
    : MODE === 'recover'
    ? `cycles=${(stats.cycles || []).length}/${CYCLES}`
    : MODE === 'thrash'
    ? `writes=${stats.sent} (${(stats.sent / Math.max(1, elapsed)).toFixed(0)}/s) replies=${stats.responses}`
    : `sent=${stats.sent} ok=${stats.valid} timeout=${stats.timeouts}`;
  console.log(`  … ${elapsed}s elapsed, ${remain}s left | ${load} link=${lastLinkAdapter ?? 'DOWN'}`);
  process.stdout.write('');
}, 30000);

// ---------------------------------------------------------------- finish

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function finish() {
  if (stopping) return;
  stopping = true;
  clearInterval(cmdTimer);
  clearInterval(monitorTimer);
  clearInterval(progressTimer);
  if (pending) clearTimeout(pending.timer);

  // Leave the reader idle — an inventory left running keeps the RF stage hot.
  if (MODE === 'inventory') { stopInventory(); }

  setTimeout(() => {
    try { ws && ws.close(); } catch { /* ignore */ }
    report();
  }, MODE === 'inventory' ? 800 : 0);
}

function report() {

  stats.panicsAtEnd = panicCount();
  stats.bridgeIdentityAtEnd = bridgeIdentity();
  stats.endedAt = new Date().toISOString();
  stats.actualDurationS = Math.round((Date.now() - started) / 1000);

  stats.summary = {
    label: stats.label,
    mode: stats.mode,
    durationS: stats.actualDurationS,
    ...(MODE === 'inventory'
      ? {
          bringupOk: stats.bringupOk,
          tagNotifications: stats.tagNotifications,
          tagsPerSec: +(stats.tagNotifications / Math.max(1, stats.actualDurationS)).toFixed(1),
          kbIn: +(stats.bytesIn / 1024).toFixed(1),
          streamGaps: stats.streamGaps,
        }
      : MODE === 'recover'
      ? {
          cyclesRequested: CYCLES,
          cyclesRun: (stats.cycles || []).filter((c) => c.induced).length,
          dropsConfirmed: (stats.cycles || []).filter((c) => c.dropConfirmed).length,
          recovered: (stats.cycles || []).filter((c) => c.recovered).length,
          failed: (stats.cycles || []).filter((c) => c.induced && !c.recovered).length,
          recoveryMs: {
            p50: percentile((stats.cycles || []).filter((c) => c.recoveryMs).map((c) => c.recoveryMs), 50),
            max: (stats.cycles || []).filter((c) => c.recoveryMs).length
              ? Math.max(...(stats.cycles || []).filter((c) => c.recoveryMs).map((c) => c.recoveryMs)) : null,
          },
        }
      : MODE === 'thrash'
      ? {
          sent: stats.sent,
          writesPerSec: +(stats.sent / Math.max(1, stats.actualDurationS)).toFixed(1),
          responses: stats.responses,
          replyRatio: stats.sent ? +(100 * stats.responses / stats.sent).toFixed(1) : 0,
          kbIn: +(stats.bytesIn / 1024).toFixed(1),
        }
      : {
          sent: stats.sent,
          valid: stats.valid,
          timeouts: stats.timeouts,
          successRate: stats.sent ? +(100 * stats.valid / stats.sent).toFixed(2) : 0,
          latencyMs: {
            p50: percentile(stats.latencies, 50),
            p95: percentile(stats.latencies, 95),
            max: stats.latencies.length ? Math.max(...stats.latencies) : null,
          },
        }),
    // null means UNOBSERVABLE, not zero. Folding an inert signal to 0 is what
    // made every previous soak report "no panics, no restarts" unconditionally.
    panics: delta(stats.panicsAtStart, stats.panicsAtEnd),
    bridgeRestarts: stats.bridgeIdentityAtStart === null ? null : stats.bridgeRestarts,
    bridgeAbsentSamples: stats.bridgeIdentityAtStart === null ? null : stats.bridgeAbsentSamples,
    wsCloses: stats.wsCloses,
    linkDrops: stats.linkDrops,
    longestSilenceS: Math.round(stats.longestSilenceMs / 1000),
  };

  delete stats._lastPanics;
  delete stats._lastBridgeId;
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `${LABEL}.json`);
  writeFileSync(outFile, JSON.stringify(stats, null, 2));

  console.log('\n' + '='.repeat(64));
  console.log(`SOAK RESULT — ${stats.label}`);
  console.log('='.repeat(64));
  for (const [k, v] of Object.entries(stats.summary)) {
    console.log(`  ${k.padEnd(18)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  console.log(`\n  written to ${outFile}`);
  process.exit(0);
}

process.on('SIGINT', finish);
process.on('SIGTERM', finish);
setTimeout(finish, MINUTES * 60 * 1000);

// ---------------------------------------------------------------- go

console.log(`\n🔬 BLE soak: ${LABEL} — ${MINUTES} min @ ${INTERVAL_MS}ms interval`);
console.log(`   adapters present: ${stats.adaptersPresent.join(', ')}`);
console.log(`   link at start:    ${stats.linkAdapterAtStart ?? 'none'}`);

// Say which health signals are actually live BEFORE spending 15 minutes, not
// after. An inert signal reports the same value as a healthy system, so the
// operator's evidence is identical either way unless it is stated up front.
if (stats.bridgeIdentityAtStart === null) {
  console.log(`   ⚠️  bridge restarts:  UNOBSERVABLE — nothing is listening on port ${WS_PORT}`);
} else {
  console.log(`   bridge process:   ${stats.bridgeIdentityAtStart}`);
}
if (stats.panicsAtStart === null) {
  console.log(`   ⚠️  rust panics:      UNOBSERVABLE — no stderr capture at ${ERR_LOG}`);
  console.log(`      set BLE_MCP_ERR_LOG to a file the bridge's stderr is redirected to`);
} else {
  console.log(`   panics at start:  ${stats.panicsAtStart}`);
}
console.log('');
connect();
