import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * The bridge's two argv spellings. Both must be protected, and **nobody chose
 * the second one** -- Python packaging generated it.
 *
 * `bridge/pyproject.toml` declares
 * `[project.scripts] ble-bridge = "ble_bridge.__main__:main"`. Distribution
 * names hyphenate by convention; module names must underscore. So one program
 * has two names, and which one appears in its argv depends only on how it was
 * launched:
 *
 *     .../bin/python3 -m ble_bridge          <- the systemd unit, UNDERSCORE
 *     .../bin/python3 .../bin/ble-bridge     <- the console script, HYPHEN
 *
 * A shebang entry point execs as `<interpreter> <script path>`, so the second
 * form carries no `ble_bridge` token at all. Protecting one spelling protects
 * half the ways the daemon can start, and the miss is silent in the worst
 * direction: the guard looks installed and the bridge still gets killed to free
 * the port -- the TRA-1170 bug, reintroduced through the launch path.
 *
 * The general test this came from is worth more than the instance: **does
 * something downstream of me generate a name I did not write?**
 */
export const BRIDGE_MODULE = 'ble_bridge';
export const BRIDGE_SCRIPT = 'ble-bridge';

/**
 * Whether `argv` belongs to a process that must never be killed to free a port.
 *
 * Matches TOKENS, never a substring of the whole command line. A command line
 * contains the absolute path of the script being run, so a substring test
 * inherits whatever anyone named a directory -- and this repo names worktrees
 * after ticket slugs, where `fix+tra-1210-ble-bridge-restart` is an entirely
 * ordinary branch name. That is the same defect that once made a worktree named
 * `test+tra-1167` look like a test runner and got it killed mid-`eslint --fix`,
 * in a different project belonging to someone else.
 *
 * So: an exact token for the module form, and a BASENAME match for the console
 * script, which is a file rather than a directory component. This is also
 * tighter than the substring check it replaces, which protected any process
 * with `ble_bridge` anywhere in its command line.
 *
 * Exported so `deploy/ble-bridge.service`'s ExecStart can be checked against the
 * real predicate rather than against a copy of it --
 * tests/unit/bridge-service-unit.test.ts.
 */
export function argvIsProtected(argv) {
  return argv.some(
    (token) => token === BRIDGE_MODULE || path.basename(token) === BRIDGE_SCRIPT
  );
}

const EXEC = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };

/**
 * PIDs *listening* on `port`.
 *
 * `-sTCP:LISTEN` is load-bearing. Without it lsof also returns every connected
 * client, the result is multi-line, and interpolating it into a command string
 * makes /bin/sh split one command into two -- which is how the guard below came
 * to be skipped and the bridge killed (TRA-1170).
 *
 * Returns [] when nothing is listening. THROWS when lsof itself failed, because
 * "lsof is broken" and "the port is free" are different answers and only one of
 * them permits killing anything.
 */
export function listenerPidsOnPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`not a port number: ${JSON.stringify(port)}`);
  }
  let out;
  try {
    out = execSync(`lsof -t -sTCP:LISTEN -i:${port}`, EXEC);
  } catch (e) {
    if (e.status === 1) return []; // lsof's "no matches"
    throw new Error(`lsof failed for port ${port} (exit ${e.status})`);
  }
  const pids = out.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const pid of pids) {
    // lsof -t is documented to print pids and nothing else; if that ever stops
    // being true we must not interpolate the surprise into a kill command.
    if (!/^\d+$/.test(pid)) throw new Error(`lsof returned a non-pid: ${JSON.stringify(pid)}`);
  }
  return pids.map(Number);
}

/**
 * Whether `pid` is one of the processes we must never kill.
 *
 * THROWS when the process cannot be inspected. Callers must treat that as
 * "unknown", never as "not protected" -- that conflation is the bug in
 * TRA-1170.
 *
 * Reads `/proc/<pid>/cmdline` rather than `ps -o args=` because the guard now
 * matches tokens, and only /proc gives real ones: it is NUL-separated, so an
 * executable path containing a space stays one argument instead of splitting
 * into two that match nothing. Both sources fail the same way on a process that
 * is gone -- ENOENT here, a non-zero exit there -- so the throw-on-unknown
 * contract above is unchanged. An empty read (a zombie, a kernel thread) is
 * "cannot inspect", not "not protected".
 */
export function isProtectedProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a pid: ${JSON.stringify(pid)}`);
  let raw;
  try {
    raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch (e) {
    throw new Error(`cannot read the command line of pid ${pid}: ${e.message}`);
  }
  const argv = raw.split('\0').filter(Boolean);
  if (!argv.length) throw new Error(`/proc/${pid}/cmdline is empty`);
  return argvIsProtected(argv);
}

/**
 * Free `port` by killing the process listening on it -- but only when we can
 * positively identify that process and it is not one of ours to protect.
 *
 * Every path that cannot answer "which single process owns this port, and what
 * is it?" returns false without killing anything. Returns true only when a
 * process was actually killed.
 */
export function killPort(port, log = console.log) {
  let pids;
  try {
    pids = listenerPidsOnPort(port);
  } catch (e) {
    log(`  Port ${port}: cannot identify the listener (${e.message}) - refusing to kill anything`);
    return false;
  }

  if (pids.length === 0) {
    log(`  Port ${port}: in use, but nothing we can see is listening - refusing to kill anything`);
    return false;
  }
  if (pids.length > 1) {
    log(`  Port ${port}: ${pids.length} processes share the listening socket (${pids.join(', ')}) - refusing to kill anything`);
    return false;
  }

  const [pid] = pids;
  let isProtected;
  try {
    isProtected = isProtectedProcess(pid);
  } catch (e) {
    log(`  Port ${port}: cannot identify pid ${pid} (${e.message}) - refusing to kill it`);
    return false;
  }
  if (isProtected) {
    log(`  Port ${port}: Production process detected (pid ${pid}) - being nice and leaving it alone! 🤝`);
    return false;
  }

  log(`  Killing process ${pid} on port ${port}`);
  execSync(`kill -9 ${pid}`, EXEC);
  return true;
}
