import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { killPort, isProtectedProcess } from '../../scripts/port-cleanup.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../fixtures/port-holder.mjs');
const SCRIPT = path.resolve(HERE, '../../scripts/pre-test-cleanup.js');

/**
 * Passed as a real argv token so it shows up in `ps -o args=`, which is what
 * the guard reads. A flag the fixture merely *interprets* would not appear
 * there and the listener would look unprotected.
 */
const PROTECTED_MARKER = 'ble_bridge';

interface Fixture {
  proc: ChildProcess;
  pid: number;
  port: number;
}

const spawned: ChildProcess[] = [];

/** Spawn a fixture and resolve once it prints `ready <pid> <port>`. */
function startFixture(args: string[]): Promise<Fixture> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [FIXTURE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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

/**
 * Whether the fixture is still running.
 *
 * Deliberately NOT `process.kill(pid, 0)`. Every fixture is a child of this
 * process, so between `kill -9` and reaping it is a zombie -- and signal 0
 * succeeds against a zombie. That check reports a killed process as alive,
 * which is precisely the direction that cannot be allowed to fail silently
 * here. Node reaps its own children, so the ChildProcess handle is authoritative.
 */
function alive(fixture: Fixture): boolean {
  return fixture.proc.exitCode === null && fixture.proc.signalCode === null;
}

/** Wait until the fixture's process has actually exited, or time out. */
function waitForExit(fixture: Fixture, ms = 5_000): Promise<void> {
  if (!alive(fixture)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pid ${fixture.pid} still alive after ${ms}ms`)), ms);
    fixture.proc.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

afterEach(() => {
  for (const proc of spawned.splice(0)) {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

describe('killPort', () => {
  it('spares a protected listener that has a client connected (TRA-1170)', async () => {
    const listener = await startFixture(['listen', PROTECTED_MARKER]);
    const client = await startFixture(['connect', '--port', String(listener.port)]);

    const logs: string[] = [];
    const killed = killPort(listener.port, (m: string) => logs.push(m));

    // Give a kill that should not have happened time to land before asserting.
    await new Promise((r) => setTimeout(r, 250));
    expect(alive(listener)).toBe(true);
    expect(alive(client)).toBe(true);
    expect(killed).toBe(false);
    expect(logs.join('\n')).toContain('Production process detected');
  });

  it('still kills an unprotected listener that has a client connected', async () => {
    const listener = await startFixture(['listen']);
    const client = await startFixture(['connect', '--port', String(listener.port)]);

    const logs: string[] = [];
    const killed = killPort(listener.port, (m: string) => logs.push(m));

    expect(killed).toBe(true);
    await waitForExit(listener);
    expect(alive(listener)).toBe(false);
    // The client was never the target and must be untouched.
    expect(alive(client)).toBe(true);
    expect(logs.join('\n')).toContain('Killing process');
  });

  it('refuses when several processes share the listening socket', async () => {
    const first = await startFixture(['listen', '--reuse-port']);
    const second = await startFixture(['listen', '--reuse-port', '--port', String(first.port)]);

    const logs: string[] = [];
    const killed = killPort(first.port, (m: string) => logs.push(m));

    await new Promise((r) => setTimeout(r, 250));
    expect(killed).toBe(false);
    expect(alive(first)).toBe(true);
    expect(alive(second)).toBe(true);
    // Pin the specific branch: three different paths log "refusing to kill
    // anything", so the generic string alone would not prove this one ran.
    expect(logs.join('\n')).toContain('2 processes share the listening socket');
  });

  it('refuses when nothing is listening on the port', async () => {
    // A port with no listener: take one, then release it.
    const transient = await startFixture(['listen']);
    const port = transient.port;
    transient.proc.kill('SIGKILL');
    await waitForExit(transient);

    const logs: string[] = [];
    expect(killPort(port, (m: string) => logs.push(m))).toBe(false);
    expect(logs.join('\n')).toContain('nothing we can see is listening');
  });

  it('reports "unknown" rather than "not protected" for a pid it cannot inspect', async () => {
    const gone = await startFixture(['listen']);
    gone.proc.kill('SIGKILL');
    await waitForExit(gone);

    // The load-bearing distinction: a dead pid must THROW, not return false.
    // Returning false here is what let the bug kill the bridge.
    expect(() => isProtectedProcess(gone.pid)).toThrow();
  });
});

/**
 * Just the port sweep's output.
 *
 * The two later phases -- orphaned runners, and the TRA-1202 staleness guard --
 * print port numbers of their own, for reasons unrelated to which ports were
 * swept. Asserting over the whole transcript conflates them.
 */
function sweepSection(output: string): string {
  const start = output.indexOf('Checking test ports...');
  const end = output.indexOf('Checking for orphaned test processes');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return output.slice(start, end);
}

describe('pre-test-cleanup.js', () => {
  it('leaves a protected listener with a connected client alive (acceptance, TRA-1170)', async () => {
    const listener = await startFixture(['listen', PROTECTED_MARKER]);
    const client = await startFixture(['connect', '--port', String(listener.port)]);

    const output = execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, BLE_MCP_TEST_PORTS: String(listener.port) },
      timeout: 45_000,
    });

    expect(alive(listener)).toBe(true);
    expect(alive(client)).toBe(true);
    // Name the port. A bare "being nice and leaving it alone" is also printed
    // when the sweep meets a real bridge on the default port 25153, so the
    // unqualified string passes against a script that ignored the override
    // entirely -- satisfied by an emitter other than the one under test.
    expect(output).toContain(`Port ${listener.port}: Production process detected`);
    // The override must actually be in force: the default ports are not swept.
    //
    // Scoped to the sweep's own section rather than to the whole output. The
    // staleness guard added by TRA-1202 runs afterwards, resolves the REAL
    // bridge port -- a different question from which ports to sweep -- and names
    // it, so an unscoped search for "Port 25153" now matches a line that says
    // nothing about whether the override was honoured.
    expect(sweepSection(output)).not.toContain('Port 25153');
    // The bug's only fingerprint. If the shell ever splits a command again,
    // this is where it shows up.
    expect(output).not.toContain('not found');
  });

  it('refuses to run with an unparseable port override rather than falling back', () => {
    expect(() =>
      execFileSync(process.execPath, [SCRIPT], {
        encoding: 'utf8',
        env: { ...process.env, BLE_MCP_TEST_PORTS: 'not-a-port' },
        timeout: 45_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ).toThrow();
  });
});
