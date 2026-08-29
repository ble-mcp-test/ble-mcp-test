import { execSync } from 'child_process';

/**
 * Command-line markers of long-running processes that must never be killed to
 * free a port.
 *
 * `ble_bridge` is the Python bridge, which runs as
 * `.../bridge/.venv/bin/python3 -m ble_bridge`. It is the only thing this repo
 * can now find holding 25153, and killing it mid-run is the TRA-1170 bug.
 *
 * Exported because `deploy/ble-bridge.service` has to keep matching it. The venv
 * also ships a `ble-bridge` console script whose argv reads `.../bin/ble-bridge`
 * -- a HYPHEN -- and pointing ExecStart at that would make the daemon stop
 * matching this list, so pretest would kill the supervised bridge to free the
 * port. tests/unit/bridge-service-unit.test.ts asserts the two agree.
 */
export const PROTECTED_MARKERS = ['ble_bridge'];

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
 */
export function isProtectedProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a pid: ${JSON.stringify(pid)}`);
  const cmdline = execSync(`ps -p ${pid} -o args=`, EXEC).trim();
  if (!cmdline) throw new Error(`ps returned nothing for pid ${pid}`);
  return PROTECTED_MARKERS.some((marker) => cmdline.includes(marker));
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
