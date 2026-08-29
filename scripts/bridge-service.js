/**
 * Render and verify the bridge's `systemctl --user` unit.
 *
 * `render` substitutes this checkout's absolute path into
 * `deploy/ble-bridge.service`, which is a template so that a second checkout on
 * another box installs the same file rather than a copy someone edited by hand.
 *
 * `check` is the interesting half. It asserts the things TRA-1202 lists as
 * acceptance criteria, in the one place they can be re-run for free -- because
 * the way an always-on service fails is by drifting from what its unit says
 * while continuing to look healthy. Every assertion here is one that can go red:
 *
 *   - the unit is active, and MainPID is the interpreter, not a `uv` wrapper
 *   - the daemon logged a REAL transport, not the stub. This is the single most
 *     important one: a stub bridge relays nothing and passes a browser suite
 *     green, because trigger injection is mock-side.
 *   - the log level it actually RESOLVED is not debug (~270MB in eight hours),
 *     which is not the same claim as "the unit asks for info" -- systemd's
 *     EnvironmentFile beats Environment=, so only the resolved value is evidence
 *   - /status answers, and the MCP control socket exists
 *   - the daemon is not older than the last commit touching bridge/
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertBridgeCurrent, resolveBridgePort } from './bridge-staleness.js';

const EXEC = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const UNIT = 'ble-bridge.service';
export const TEMPLATE = path.join(REPO_ROOT, 'deploy', UNIT);

/** Where `systemctl --user` looks for units it did not ship itself. */
export function installedUnitPath(home = os.homedir()) {
  return path.join(home, '.config', 'systemd', 'user', UNIT);
}

/**
 * Substitute this checkout's path into the unit template.
 *
 * Refuses to emit a unit with an unsubstituted placeholder left in it. systemd
 * would accept `ExecStart=@REPO_ROOT@/bridge/...` as a path, fail to execute it,
 * and report a start failure that names a file nobody will recognise.
 */
export function renderUnit(template, repoRoot) {
  if (!path.isAbsolute(repoRoot)) {
    throw new Error(`repo root must be absolute, got ${JSON.stringify(repoRoot)}`);
  }
  if (!template.includes('@REPO_ROOT@')) {
    throw new Error('the unit template has no @REPO_ROOT@ placeholder left to substitute');
  }
  const rendered = template.replaceAll('@REPO_ROOT@', repoRoot.replace(/\/+$/, ''));
  const leftover = /@[A-Z0-9_]+@/.exec(rendered);
  if (leftover) {
    throw new Error(`the rendered unit still contains a placeholder: ${leftover[0]}`);
  }
  return rendered;
}

function systemctl(...args) {
  return execFileSync('systemctl', ['--user', ...args], EXEC).trim();
}

function show(property) {
  try {
    return systemctl('show', UNIT, '-p', property, '--value');
  } catch (e) {
    throw new Error(`systemctl --user show ${UNIT} failed: ${e.message}`);
  }
}

/** Everything the CURRENT start of the unit has logged. */
function invocationLog() {
  const invocation = show('InvocationID');
  if (!invocation) {
    throw new Error(
      `${UNIT} has no InvocationID, which means it has never started under this ` +
        'user manager. Run: just bridge-install'
    );
  }
  return execFileSync(
    'journalctl',
    ['--user', `_SYSTEMD_INVOCATION_ID=${invocation}`, '-o', 'cat', '--no-pager'],
    EXEC
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for the daemon to have logged the line that says which transport it got.
 *
 * The line is emitted before the relay starts listening, so waiting for it is
 * also waiting for the daemon to be up. Bounded: a unit that has gone to
 * `failed` is reported as failed rather than waited on until the timeout, so the
 * message names the real problem instead of "timed out".
 */
async function waitForStartupLog(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = show('ActiveState');
    if (state === 'failed') {
      const log = invocationLog();
      throw new Error(
        `${UNIT} is in state 'failed'. Its last start logged:\n${indent(log)}\n` +
          `  systemctl --user status ${UNIT}`
      );
    }
    if (state === 'active') {
      const log = invocationLog();
      if (/^(ESPHome transport:|.*ESPHome transport:)/m.test(log)) return log;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${UNIT} did not log a transport line within ${timeoutMs / 1000}s ` +
          `(ActiveState=${state}). Logged so far:\n${indent(invocationLog())}`
      );
    }
    await sleep(500);
  }
}

const indent = (s) => s.split('\n').map((l) => `    ${l}`).join('\n');

async function check() {
  const problems = [];
  const say = (m) => console.log(`  ${m}`);

  const state = show('ActiveState');
  if (state !== 'active') {
    const log = show('InvocationID') ? invocationLog() : '(never started)';
    throw new Error(`${UNIT} is ${state}, not active. Last start logged:\n${indent(log)}`);
  }
  say(`${UNIT}: active`);

  // MainPID must be the daemon, not a wrapper. `uv run python -m ble_bridge`
  // spawns the real interpreter as a CHILD, so a unit pointed at uv would have
  // systemd supervising, restarting and reporting on the wrong process.
  const mainPid = Number(show('MainPID'));
  if (!Number.isInteger(mainPid) || mainPid <= 0) {
    throw new Error(`${UNIT} reports MainPID=${mainPid}: there is no daemon to check`);
  }
  const argv = readFileSync(`/proc/${mainPid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  if (!argv[0].endsWith('/python3') || !argv.includes('ble_bridge')) {
    problems.push(
      `MainPID ${mainPid} is not the interpreter running the daemon: ${argv.join(' ')}\n` +
        '    ExecStart must be <venv>/bin/python3 -m ble_bridge, never `uv run`.'
    );
  } else {
    say(`MainPID ${mainPid}: ${argv.join(' ')}`);
  }

  const log = await waitForStartupLog();

  // The single most important check in this file. A stub transport relays
  // nothing and reports healthy, and the browser suite goes green against it
  // because trigger injection is mock-side -- a false hardware verification,
  // which costs more than any startup failure.
  const transport = /^.*ESPHome transport: .*$/m.exec(log);
  if (!transport) {
    problems.push(`the daemon never logged an ESPHome transport line:\n${indent(log)}`);
  } else {
    say(transport[0].trim());
  }
  if (/stub/i.test(log)) {
    problems.push(`the daemon's log mentions a stub transport:\n${indent(log)}`);
  }

  // The RESOLVED level, read back out of the daemon rather than out of the unit.
  // systemd's EnvironmentFile= overrides Environment=, so what the unit asks for
  // is not evidence of what the process is doing.
  const level = /^.*log level (\w+),/m.exec(log);
  if (!level) {
    problems.push(`the daemon never said what log level it resolved:\n${indent(log)}`);
  } else if (level[1].toUpperCase() === 'DEBUG') {
    problems.push(
      'the daemon resolved BLE_MCP_LOG_LEVEL=debug. At debug the log grows ~270MB in\n' +
        '    eight hours and journald will evict everything else. Set BLE_MCP_LOG_LEVEL=info\n' +
        `    in ${path.join(REPO_ROOT, '.env.local')} -- the unit cannot override it, because\n` +
        '    EnvironmentFile= beats Environment= for the same key.'
    );
  } else {
    say(`log level: ${level[1]}`);
  }

  const port = resolveBridgePort();
  try {
    const status = execFileSync(
      'curl',
      ['-sf', '--max-time', '5', `http://127.0.0.1:${port}/status`],
      EXEC
    ).trim();
    say(`GET /status on ${port}: ${status}`);
  } catch (e) {
    problems.push(`GET http://127.0.0.1:${port}/status did not answer: ${e.message}`);
  }

  // The reason the unit has to be --user at all: /run/user/<uid> does not exist
  // for a system unit, and the whole MCP surface lives on this socket.
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const socket = path.join(runtimeDir, 'ble-bridge.sock');
  if (existsSync(socket)) {
    say(`MCP control socket: ${socket}`);
  } else {
    problems.push(
      `the MCP control socket ${socket} does not exist. If the unit was installed at\n` +
        '    system scope rather than --user, the daemon comes up looking healthy with the\n' +
        '    entire MCP surface silently missing.'
    );
  }

  try {
    assertBridgeCurrent({ log: (m) => say(m.trim()) });
  } catch (e) {
    problems.push(e.message);
  }

  if (problems.length) {
    throw new Error(
      `${problems.length} problem(s) with ${UNIT}:\n\n` +
        problems.map((p, i) => `  ${i + 1}. ${p}`).join('\n\n')
    );
  }
  console.log(`\n✅ ${UNIT} is healthy, on a real transport, and current.`);
}

const command = process.argv[2];
if (command === 'render') {
  // The optional argument renders the unit for a DIFFERENT checkout than the one
  // this script lives in. `just bridge-install` never passes it -- installing a
  // unit that points somewhere other than where you are is not a thing to do by
  // accident -- but a container image, or a verification run from a worktree
  // against the checkout that will actually serve, needs to say so explicitly.
  process.stdout.write(renderUnit(readFileSync(TEMPLATE, 'utf8'), process.argv[3] ?? REPO_ROOT));
} else if (command === 'check') {
  check().catch((e) => {
    console.error(`\n${e.message}\n`);
    process.exit(1);
  });
} else if (command === 'unit-path') {
  process.stdout.write(installedUnitPath());
} else if (command !== undefined) {
  console.error(`unknown command: ${command}. Use render, check or unit-path.`);
  process.exit(2);
}
