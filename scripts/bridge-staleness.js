/**
 * Is the bridge daemon that will answer this run older than the code it claims
 * to be running?
 *
 * An always-on service is a stale server, and supervision makes that MORE
 * likely rather than less: nobody thinks to restart something that never
 * crashes. On 2026-08-28 a daemon had to be killed before publishing because it
 * was serving pre-merge code, and nothing in the system said so.
 *
 * `/status` cannot answer this. It reports `version: "0.1.0"` -- the Python
 * package version, unchanged through the entire replatform -- so it reports the
 * same string for today's code and for six-month-old code. A check that cannot
 * go red.
 *
 * ## Why this asks the PORT rather than asking systemd
 *
 * TRA-1202 sketched `systemctl --user show -p MainPID <unit>`. That answers a
 * narrower question than the one being asked: "is the UNIT fresh", not "is the
 * process that will actually answer this run fresh". Those diverge exactly when
 * a stale ad-hoc daemon holds the port while the unit is stopped -- the systemd
 * form passes and the run is answered by old code anyway. A check satisfied by
 * the wrong subject is this repo's second named failure class.
 *
 * So discovery starts from the port the run will use, and the process found
 * there is identified as the bridge before it is judged.
 *
 * ## Why the daemon's OWN checkout is the denominator
 *
 * The comparison is against the tree the daemon was started from -- read from
 * `/proc/<pid>/cwd`, not from wherever this script happens to be running.
 *
 * Judging against the CURRENT tree would fail every worktree the moment it
 * commits to `bridge/`, for a daemon serving `main` that is not stale at all.
 * The daemon's unmerged-branch-ness is not a property of the daemon.
 *
 * ## Two signals, because neither one covers the other
 *
 * The daemon must be newer than BOTH the last commit touching `bridge/` and the
 * newest file under `bridge/src`.
 *
 *   - a `git commit` moves the commit date without touching a single file mtime
 *   - a `git merge` rewrites the files, but `git log -1 -- bridge/` still
 *     reports the date of the commit that made the change rather than the merge
 *     that brought it in -- which is exactly the 2026-08-28 incident: committed
 *     at 09:50, daemon restarted at 10:00, merged at 11:00, and the commit
 *     timestamp says the daemon is current
 *
 * Taking the union is the sensitive direction on purpose. A false STALE costs
 * one `just bridge-restart`; a false CURRENT is the whole failure, and silent.
 *
 * The mtime leg WILL fire occasionally with no merge behind it -- a `git
 * checkout`, a `git clean` and a fresh clone all rewrite files under
 * `bridge/src`. That noise is the price. Do not pay for quiet by deleting the
 * mtime leg: the commit date alone cannot see a merge, which is the case above.
 *
 * ## Where it is deliberately blunt
 *
 * Every path that cannot answer the question raises. "I could not check" is the
 * silent pass this guard exists to prevent, and a guard that degrades to a
 * shrug is one that has already stopped working the day you need it.
 */

import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isProtectedProcess, listenerPidsOnPort } from './port-cleanup.js';

const EXEC = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Must match `DEFAULT_WS_PORT` in bridge/src/ble_bridge/config.py. */
export const DEFAULT_WS_PORT = 25153;

const PORT_ENV = 'BLE_MCP_WS_PORT';

/**
 * The port the bridge is listening on, resolved the way the bridge itself
 * resolves it.
 *
 * `__main__.py` calls `load_dotenv(.env.local)` with dotenv's default
 * `override=False`, so a real environment variable beats the file and the file
 * beats the built-in default. Guessing a different precedence here would point
 * the guard at a port no daemon is on, and "no daemon" is a PASS -- an
 * over-satisfiable check that launders a stale daemon into a clean run.
 *
 * A value that is present but unusable raises. Falling back to 25153 would
 * check a port the operator's evidence says is not the one in use.
 */
export function resolveBridgePort({ env = process.env, repoRoot = REPO_ROOT } = {}) {
  const fromEnv = env[PORT_ENV];
  if (fromEnv !== undefined) return parsePort(fromEnv, `${PORT_ENV} is set but`);

  const fromFile = readEnvFileValue(path.join(repoRoot, '.env.local'), PORT_ENV);
  if (fromFile !== null) return parsePort(fromFile, `.env.local sets ${PORT_ENV} but it`);

  return DEFAULT_WS_PORT;
}

function parsePort(raw, prefix) {
  const port = Number(String(raw).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${prefix} is not a port number: ${JSON.stringify(raw)}`);
  }
  return port;
}

/**
 * One `KEY=value` out of a dotenv file, or null.
 *
 * Deliberately not the `dotenv` package: this must agree with what SYSTEMD's
 * parser does to the same file, and the unit points `EnvironmentFile=` at it.
 * The shapes the two parsers disagree about -- `export ` prefixes, `$(...)`,
 * quoted values, trailing `#` comments -- are the ones `deploy/ble-bridge.service`
 * documents as forbidden, so the intersection is this: an unquoted literal.
 */
function readEnvFileValue(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = new RegExp(`^\\s*${key}=(.*)$`).exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/** Clock ticks per second, asked for rather than assumed to be 100. */
function clockTicks() {
  const out = execFileSync('getconf', ['CLK_TCK'], EXEC).trim();
  if (!/^\d+$/.test(out) || Number(out) === 0) {
    throw new Error(`getconf CLK_TCK gave no usable value: ${JSON.stringify(out)}`);
  }
  return Number(out);
}

/** Wall-clock time the machine booted, epoch seconds. */
function bootTime() {
  const m = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'));
  if (!m) throw new Error('/proc/stat has no btime line');
  return Number(m[1]);
}

/**
 * When `pid` started, as epoch seconds.
 *
 * Computed from `/proc/<pid>/stat` field 22 (start time in clock ticks since
 * boot) plus `/proc/stat`'s `btime`, rather than from either of the two shell
 * forms that suggest themselves.
 *
 * `ps -o lstart=` piped through `date -d`, which TRA-1202 sketched, parses a
 * formatted date string and so can be changed by a locale or a timezone.
 *
 * `ps -o etimes=` looked like the fix -- an integer, nothing to parse -- and it
 * is WRONG on this box for a young process. Measured on procps 4.0.4: a process
 * a fraction of a second old reported `4123168576` seconds elapsed, dating it to
 * 1896. A daemon that had just been restarted would therefore be judged the most
 * stale thing on the system, which is the failure pointing in the direction that
 * costs the most: it fires on the machine that has just done the right thing.
 * Verified against the same field: `/proc` agrees with `ps -o lstart=` to the
 * second on a ten-hour-old daemon and is correct at t+0.
 */
export function processStartedAt(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a pid: ${JSON.stringify(pid)}`);
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (e) {
    throw new Error(`cannot read the start time of pid ${pid}: ${e.message}`);
  }
  // Fields 1 (pid) and 2 (comm) are dropped first: comm is the executable name
  // in parentheses and may itself contain spaces and parentheses, so it cannot
  // be split through. After the drop, field N is at index N-3.
  const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(after[19]);
  if (!Number.isFinite(ticks)) {
    throw new Error(`/proc/${pid}/stat has no start time: ${JSON.stringify(after[19])}`);
  }
  return Math.floor(bootTime() + ticks / clockTicks());
}

/**
 * The git checkout `pid` is running out of, or null when it is not in one.
 *
 * `/proc/<pid>/cwd` is the daemon's working directory -- `<checkout>/bridge`
 * under the unit -- and `rev-parse --show-toplevel` walks up from there.
 */
export function checkoutOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a pid: ${JSON.stringify(pid)}`);
  let cwd;
  try {
    cwd = realpathSync(`/proc/${pid}/cwd`);
  } catch (e) {
    throw new Error(`cannot read the working directory of pid ${pid}: ${e.message}`);
  }
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], EXEC).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Committer timestamp of the last commit touching `bridge/` in `checkout`, or
 * null when there is none.
 *
 * `git -C <checkout>` is load-bearing and is the trap TRA-1202 hit while
 * verifying this by hand: a pathspec is relative to the working directory, so
 * `git log -- bridge/` run from inside `bridge/` means `bridge/bridge/` and
 * returns empty -- which reads as "no commits" rather than as "wrong query",
 * and an empty answer here would look like a daemon that cannot be stale.
 */
export function lastBridgeCommitAt(checkout) {
  const out = execFileSync(
    'git',
    ['-C', checkout, 'log', '-1', '--format=%ct', '--', 'bridge/'],
    EXEC
  ).trim();
  return out ? Number(out) : null;
}

/**
 * Newest mtime under `<checkout>/bridge/src`, epoch seconds, or null.
 *
 * The second half of the verdict, and the half that catches a merge.
 *
 * The commit timestamp alone has a hole big enough to drive the exact incident
 * of 2026-08-28 through. Work is committed on a branch at 09:50, the daemon is
 * restarted at 10:00, the PR merges at 11:00 -- and `git log -1 -- bridge/` on
 * main still reports 09:50, because a path-limited log reports the commit that
 * made the change, not the merge that brought it in. The daemon started after
 * that timestamp and is judged current while serving pre-merge code.
 *
 * File mtimes do not have that hole: a merge rewrites the files, so the daemon
 * is older than the code on disk and says so. They also catch an uncommitted
 * edit, which no commit timestamp ever will.
 *
 * `bridge/src` is the right directory rather than `bridge/`: the venv installs
 * this package EDITABLE (`_editable_impl_ble_bridge.pth` points at
 * `<checkout>/bridge/src`), so those files are literally what the interpreter
 * imports. `__pycache__` is skipped -- bytecode is written by the running
 * process, so including it would let the daemon's own execution make it look
 * stale.
 */
export function newestSourceMtime(checkout) {
  const root = path.join(checkout, 'bridge', 'src');
  if (!existsSync(root)) return null;
  let newest = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  walk(root);
  return newest ? Math.floor(newest / 1000) : null;
}

/**
 * Throw unless the daemon answering `port` is running code at least as new as
 * the last commit to `bridge/` in its own checkout.
 *
 * Returns a description of what was checked, so a caller can say which of the
 * several passing paths it took. "No daemon" and "daemon is current" are both
 * passes, and they are not the same claim.
 */
export function assertBridgeCurrent({ port, log = console.log } = {}) {
  const wsPort = port ?? resolveBridgePort();

  const pids = listenerPidsOnPort(wsPort);
  if (pids.length === 0) {
    log(`  Port ${wsPort}: no bridge listening - nothing can be stale`);
    return { checked: false, reason: 'no listener', port: wsPort };
  }
  if (pids.length > 1) {
    throw new Error(
      `Port ${wsPort}: ${pids.length} processes share the listening socket (${pids.join(', ')}). ` +
        'Cannot tell which one would answer this run, so cannot tell whether it is current.'
    );
  }

  const [pid] = pids;
  if (!isProtectedProcess(pid)) {
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], EXEC).trim();
    throw new Error(
      `Port ${wsPort} is held by pid ${pid}, which is not the bridge: ${args}\n` +
        'The bridge port is answering for something else. Stop it, then start the bridge.'
    );
  }

  const checkout = checkoutOf(pid);
  if (checkout === null) {
    throw new Error(
      `The bridge on port ${wsPort} (pid ${pid}) is not running out of a git checkout, ` +
        'so how old its code is cannot be established. Run it from a checkout, or stop it.'
    );
  }

  const committed = lastBridgeCommitAt(checkout);
  if (committed === null) {
    throw new Error(
      `The bridge on port ${wsPort} (pid ${pid}) runs out of ${checkout}, which has no ` +
        'commits touching bridge/. That is not a ble-mcp-test checkout.'
    );
  }

  // Two signals, and the daemon has to be newer than BOTH. Neither subsumes the
  // other: a merge moves the files without moving the commit date a path-limited
  // log reports, and a `git commit` moves the date without touching a file.
  //
  // The union is deliberately the sensitive direction. A false STALE costs one
  // `just bridge-restart`; a false CURRENT is the entire failure this guard
  // exists to prevent, and it is silent.
  const sourceAt = newestSourceMtime(checkout);
  const newest = sourceAt === null ? committed : Math.max(committed, sourceAt);
  const which = sourceAt !== null && sourceAt > committed ? 'source file under bridge/src' : 'commit touching bridge/';

  const started = processStartedAt(pid);
  if (started <= newest) {
    const ageMinutes = Math.round((newest - started) / 60);
    throw new Error(
      `STALE BRIDGE: the daemon on port ${wsPort} (pid ${pid}) started ${ageMinutes} minute(s) ` +
        `BEFORE the newest ${which} in ${checkout}.\n` +
        `  daemon started:  ${new Date(started * 1000).toISOString()}\n` +
        `  bridge/ commit:  ${new Date(committed * 1000).toISOString()}\n` +
        `  bridge/src file: ${sourceAt === null ? '(none)' : new Date(sourceAt * 1000).toISOString()}\n` +
        'It is serving code older than the tree it came from, and it would have answered this ' +
        'run without saying so. Restart it:  just bridge-restart'
    );
  }

  log(
    `  Port ${wsPort}: bridge pid ${pid} started ${Math.round((started - newest) / 60)} ` +
      `minute(s) after the newest ${which} in ${checkout} - current`
  );
  return { checked: true, port: wsPort, pid, checkout, started, committed, sourceAt };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    assertBridgeCurrent();
  } catch (e) {
    console.error(`\n${e.message}\n`);
    process.exit(1);
  }
}
