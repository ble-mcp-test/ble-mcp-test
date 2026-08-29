import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  DEFAULT_WS_PORT,
  assertBridgeCurrent,
  checkoutOf,
  lastBridgeCommitAt,
  newestSourceMtime,
  processStartedAt,
  resolveBridgePort,
} from '../../scripts/bridge-staleness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../fixtures/port-holder.mjs');
const PRETEST = path.resolve(HERE, '../../scripts/pre-test-cleanup.js');

/**
 * Passed as a real argv token, because `isProtectedProcess` reads `ps -o args=`.
 * A fixture that merely interpreted a flag would not appear there and would be
 * judged "not the bridge" -- which is a different branch than the one under test.
 */
const BRIDGE_MARKER = 'ble_bridge';

const spawned: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const proc of spawned.splice(0)) {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A throwaway checkout with one commit touching `bridge/`, dated `commitEpoch`.
 *
 * The date is set through GIT_COMMITTER_DATE rather than by waiting, so a test
 * can put the commit in the future relative to a process that is already
 * running -- which is the only way to exercise "stale" without sleeping.
 */
function makeCheckout(commitEpoch: number, srcMtimeEpoch = commitEpoch): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ble-staleness-'));
  tempDirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: `${commitEpoch} +0000`,
        GIT_COMMITTER_DATE: `${commitEpoch} +0000`,
      },
    });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'staleness test');
  const src = path.join(dir, 'bridge', 'src', 'ble_bridge');
  mkdirSync(src, { recursive: true });
  const module = path.join(src, 'server.py');
  writeFileSync(module, '# the code the daemon imports\n');
  // The venv installs this package editable, so the file's mtime is the mtime of
  // what the interpreter actually loaded. Set it independently of the commit
  // date: the two move apart on a merge, which is the case that matters.
  utimesSync(module, srcMtimeEpoch, srcMtimeEpoch);
  git('add', 'bridge');
  git('commit', '-q', '-m', 'seed bridge/');
  // `git add`/`git commit` do not touch working-tree mtimes, but be explicit
  // rather than rely on it.
  utimesSync(module, srcMtimeEpoch, srcMtimeEpoch);
  return dir;
}

/** A stand-in daemon: listening, identifiable as the bridge, running in `cwd`. */
function startFakeDaemon(cwd: string): Promise<{ proc: ChildProcess; pid: number; port: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [FIXTURE, 'listen', BRIDGE_MARKER], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawned.push(proc);
    let stderr = '';
    proc.stderr!.on('data', (d) => { stderr += String(d); });
    proc.stdout!.on('data', (d) => {
      const m = /^ready (\d+) (\d+)$/m.exec(String(d));
      if (m) resolve({ proc, pid: Number(m[1]), port: Number(m[2]) });
    });
    proc.on('exit', (code) => reject(new Error(`fixture exited ${code} before ready: ${stderr}`)));
    setTimeout(() => reject(new Error(`fixture never became ready: ${stderr}`)), 10_000);
  });
}

const HOUR = 3600;

describe('resolveBridgePort', () => {
  it('prefers a real environment variable, as the bridge itself does', () => {
    expect(resolveBridgePort({ env: { BLE_MCP_WS_PORT: '31337' }, repoRoot: '/nonexistent' }))
      .toBe(31337);
  });

  it('falls back to .env.local, which is what the systemd unit points at', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ble-envfile-'));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, '.env.local'), 'BLE_MCP_LOG_LEVEL=info\nBLE_MCP_WS_PORT=24601\n');
    expect(resolveBridgePort({ env: {}, repoRoot: dir })).toBe(24601);
  });

  it('falls back to the port config.py defaults to when nothing says otherwise', () => {
    expect(resolveBridgePort({ env: {}, repoRoot: '/nonexistent' })).toBe(DEFAULT_WS_PORT);
  });

  it('refuses a set-but-unparseable port rather than checking the default one', () => {
    // The dangerous direction: falling back to 25153 would check a port the
    // operator's evidence says is not in use, find nothing, and PASS.
    expect(() => resolveBridgePort({ env: { BLE_MCP_WS_PORT: 'nope' }, repoRoot: '/nonexistent' }))
      .toThrow(/not a port number/);
  });
});

describe('the pieces the verdict is assembled from', () => {
  it('dates a JUST-STARTED process to now, which is where ps -o etimes= is wrong', async () => {
    // procps 4.0.4 reports 4123168576 elapsed seconds for a process a fraction
    // of a second old, dating it to 1896. That makes a daemon that has just been
    // restarted the most stale thing on the system -- the guard firing hardest
    // on the machine that has just done the right thing. This is the case that
    // has to be pinned, not the easy old-process one below.
    const daemon = await startFakeDaemon(os.tmpdir());
    const started = processStartedAt(daemon.pid);
    const now = Math.floor(Date.now() / 1000);
    expect(started).toBeGreaterThanOrEqual(now - 30);
    expect(started).toBeLessThanOrEqual(now);
  });

  it('agrees with ps -o lstart= on a long-running process', () => {
    // The independent reading. /proc arithmetic that agreed only with itself
    // would be self-consistent and could still be uniformly wrong.
    const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', '1'], { encoding: 'utf8' }).trim();
    const fromPs = Math.floor(new Date(lstart).getTime() / 1000);
    expect(Math.abs(processStartedAt(1) - fromPs)).toBeLessThanOrEqual(1);
  });

  it('finds the checkout a process is running out of, not the one asking', async () => {
    const checkout = makeCheckout(Math.floor(Date.now() / 1000) - HOUR);
    const daemon = await startFakeDaemon(path.join(checkout, 'bridge'));
    // Started from <checkout>/bridge, exactly as WorkingDirectory= puts the daemon.
    expect(checkoutOf(daemon.pid)).toBe(execFileSync('git', ['-C', checkout, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
  });

  it('reads the bridge/ commit date with the pathspec relative to the checkout', () => {
    const at = Math.floor(Date.now() / 1000) - HOUR;
    const checkout = makeCheckout(at);
    // The TRA-1202 trap: running this from inside bridge/ would mean
    // bridge/bridge/ and return null, which reads as "cannot be stale".
    expect(lastBridgeCommitAt(checkout)).toBe(at);
  });

  it('reads the newest mtime under bridge/src, which is what the venv imports', () => {
    const at = Math.floor(Date.now() / 1000) - HOUR;
    const checkout = makeCheckout(at - HOUR, at);
    expect(newestSourceMtime(checkout)).toBe(at);
  });

  it('ignores __pycache__, which the daemon writes as it runs', () => {
    // Bytecode is produced by the running process. Counting it would let a
    // daemon's own execution make the daemon look stale.
    const at = Math.floor(Date.now() / 1000) - HOUR;
    const checkout = makeCheckout(at, at);
    const cache = path.join(checkout, 'bridge', 'src', 'ble_bridge', '__pycache__');
    mkdirSync(cache);
    writeFileSync(path.join(cache, 'server.cpython-312.pyc'), 'fresh bytecode');
    expect(newestSourceMtime(checkout)).toBe(at);
  });

  it('is null for a tree with no bridge/src at all', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ble-nosrc-'));
    tempDirs.push(dir);
    expect(newestSourceMtime(dir)).toBeNull();
  });
});

describe('assertBridgeCurrent', () => {
  it('passes when nothing is listening: there is no daemon to be stale', () => {
    // A port nothing holds. 0 is not a valid listen port for lsof, so use a
    // high one and prove it is free by the guard's own report.
    const logs: string[] = [];
    const result = assertBridgeCurrent({ port: 27999, log: (m: string) => logs.push(m) });
    expect(result.checked).toBe(false);
    expect(logs.join('\n')).toContain('no bridge listening');
  });

  it('passes when the daemon started after the last bridge/ commit', async () => {
    const checkout = makeCheckout(Math.floor(Date.now() / 1000) - HOUR);
    const daemon = await startFakeDaemon(path.join(checkout, 'bridge'));

    const logs: string[] = [];
    const result = assertBridgeCurrent({ port: daemon.port, log: (m: string) => logs.push(m) });

    expect(result.checked).toBe(true);
    expect(result.pid).toBe(daemon.pid);
    expect(logs.join('\n')).toContain('current');
  });

  it('FAILS when the daemon predates a source file, even with an OLD commit date', async () => {
    // The merge case, which the commit timestamp alone cannot see. Work is
    // committed on a branch at T, the daemon is restarted at T+1, and the merge
    // lands at T+2 -- but `git log -1 -- bridge/` on main still reports T,
    // because a path-limited log names the commit that made the change, not the
    // merge that brought it in. The files, however, were rewritten by the merge.
    const now = Math.floor(Date.now() / 1000);
    const checkout = makeCheckout(now - 2 * HOUR, now + HOUR);
    const daemon = await startFakeDaemon(path.join(checkout, 'bridge'));

    expect(() => assertBridgeCurrent({ port: daemon.port, log: () => {} }))
      .toThrow(/STALE BRIDGE.*source file under bridge\/src/s);
  });

  it('FAILS when the daemon predates the last bridge/ commit, with OLD source files', async () => {
    // The other half of the union, pinned on its own: a commit in the future
    // relative to the running fixture while the files on disk are old. `git
    // commit` does not touch working-tree mtimes, so the source check cannot see
    // this one and only the commit date can. This is the case TRA-1202 names in
    // its acceptance criteria.
    const now = Math.floor(Date.now() / 1000);
    const checkout = makeCheckout(now + HOUR, now - HOUR);
    const daemon = await startFakeDaemon(path.join(checkout, 'bridge'));

    expect(() => assertBridgeCurrent({ port: daemon.port, log: () => {} }))
      .toThrow(/STALE BRIDGE.*commit touching bridge\//s);
  });

  it('names the remedy in the failure, so the message is actionable', async () => {
    const checkout = makeCheckout(Math.floor(Date.now() / 1000) + HOUR);
    const daemon = await startFakeDaemon(path.join(checkout, 'bridge'));

    expect(() => assertBridgeCurrent({ port: daemon.port, log: () => {} }))
      .toThrow(/just bridge-restart/);
  });

  it('refuses to judge a listener that is not the bridge', async () => {
    const checkout = makeCheckout(Math.floor(Date.now() / 1000) - HOUR);
    const proc = spawn(process.execPath, [FIXTURE, 'listen'], {
      cwd: path.join(checkout, 'bridge'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawned.push(proc);
    const port = await new Promise<number>((resolve, reject) => {
      proc.stdout!.on('data', (d) => {
        const m = /^ready (\d+) (\d+)$/m.exec(String(d));
        if (m) resolve(Number(m[2]));
      });
      setTimeout(() => reject(new Error('fixture never became ready')), 10_000);
    });

    // Fresh by timestamp, but not the bridge. Passing here would mean the guard
    // is satisfied by a subject other than the one it is about.
    expect(() => assertBridgeCurrent({ port, log: () => {} }))
      .toThrow(/is not the bridge/);
  });

  it('refuses to judge a bridge that is not running out of a checkout', async () => {
    const daemon = await startFakeDaemon(os.tmpdir());
    expect(() => assertBridgeCurrent({ port: daemon.port, log: () => {} }))
      .toThrow(/not running out of a git checkout/);
  });
});

describe('pre-test-cleanup.js wiring', () => {
  it('exits NON-ZERO when the staleness guard fails', async () => {
    // The guard is worthless if pretest reports the failure and exits 0. Before
    // TRA-1202 the script ended `cleanup().catch(console.error)`, which did
    // exactly that -- a check that cannot fail the thing it gates.
    const checkout = makeCheckout(Math.floor(Date.now() / 1000) + HOUR);
    const daemon = await startFakeDaemon(path.join(checkout, 'bridge'));

    let status: number | null = null;
    let output = '';
    try {
      execFileSync(process.execPath, [PRETEST], {
        encoding: 'utf8',
        env: {
          ...process.env,
          BLE_MCP_TEST_PORTS: String(daemon.port),
          BLE_MCP_WS_PORT: String(daemon.port),
        },
        timeout: 45_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      status = 0;
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      status = err.status ?? null;
      output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }

    expect(status).not.toBe(0);
    expect(output).toContain('STALE BRIDGE');
  });

  it('exits zero when the daemon on the port is current', async () => {
    const checkout = makeCheckout(Math.floor(Date.now() / 1000) - HOUR);
    const daemon = await startFakeDaemon(path.join(checkout, 'bridge'));

    const output = execFileSync(process.execPath, [PRETEST], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BLE_MCP_TEST_PORTS: String(daemon.port),
        BLE_MCP_WS_PORT: String(daemon.port),
      },
      timeout: 45_000,
    });

    expect(output).toContain('current');
  });
});

/**
 * One commit touching exactly `relPath`, dated `epoch`.
 *
 * Separate from makeCheckout because the case under test is a SECOND commit that
 * lands somewhere the daemon does not read -- which is only meaningful against a
 * checkout that already has a real one.
 */
function commitTouching(dir: string, relPath: string, epoch: number): number {
  const full = path.join(dir, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, `# touched at ${epoch}\n`);
  const run = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: `${epoch} +0000`,
        GIT_COMMITTER_DATE: `${epoch} +0000`,
      },
    });
  run('add', relPath);
  run('commit', '-q', '-m', `touch ${relPath}`);
  return epoch;
}

/**
 * The commit leg answers "when did the code this daemon RUNS last change".
 *
 * On 2026-08-29 it answered a broader question -- "when did anything under
 * `bridge/` last change" -- and a commit touching only `bridge/tests/` produced a
 * STALE for a daemon whose `bridge/src` was demonstrably older than it. The mtime
 * leg, scoped to `bridge/src`, got that case right; the two legs disagreed because
 * they were scoped to different subjects.
 *
 * Both directions are pinned here. The "still sees" cases are not padding: the
 * obvious narrowing -- scoping to `bridge/src` -- passes the first test and fails
 * those, and it fails in the silent direction the whole guard exists to prevent.
 */
describe('the commit leg asks about the code the daemon runs', () => {
  const seeded = 1_700_000_000;
  const later = seeded + HOUR;

  it('ignores a commit that touches only bridge/tests/', () => {
    const checkout = makeCheckout(seeded);
    commitTouching(checkout, 'bridge/tests/test_relay.py', later);
    expect(lastBridgeCommitAt(checkout)).toBe(seeded);
  });

  it('ignores a tests-only commit even when it is the newest thing in the repo', () => {
    // Ordering guard: the exclusion has to survive being the most recent commit,
    // which is the only arrangement that produced the incident.
    const checkout = makeCheckout(seeded);
    commitTouching(checkout, 'bridge/src/ble_bridge/notify.py', seeded + 60);
    commitTouching(checkout, 'bridge/tests/test_relay.py', later);
    expect(lastBridgeCommitAt(checkout)).toBe(seeded + 60);
  });

  it('still sees a commit to bridge/pyproject.toml', () => {
    // Dependencies and the dynamic version both live here. Scoping the leg to
    // bridge/src would miss this -- a false CURRENT, which is silent.
    const checkout = makeCheckout(seeded);
    commitTouching(checkout, 'bridge/pyproject.toml', later);
    expect(lastBridgeCommitAt(checkout)).toBe(later);
  });

  it('still sees a commit to bridge/uv.lock', () => {
    const checkout = makeCheckout(seeded);
    commitTouching(checkout, 'bridge/uv.lock', later);
    expect(lastBridgeCommitAt(checkout)).toBe(later);
  });

  it('still sees a commit to bridge/src/', () => {
    const checkout = makeCheckout(seeded);
    commitTouching(checkout, 'bridge/src/ble_bridge/notify.py', later);
    expect(lastBridgeCommitAt(checkout)).toBe(later);
  });

  it('counts a file added under bridge/ that nobody has classified', () => {
    // The fail-safe default, asserted rather than assumed. An inclusion list would
    // return `seeded` here and the guard would silently stop covering whatever the
    // new thing is. This test is why the pathspec is an exclusion.
    const checkout = makeCheckout(seeded);
    commitTouching(checkout, 'bridge/some-new-thing.toml', later);
    expect(lastBridgeCommitAt(checkout)).toBe(later);
  });
});
