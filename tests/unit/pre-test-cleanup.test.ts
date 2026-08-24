import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { killPort } from '../../scripts/port-cleanup.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/port-holder.mjs'
);

/**
 * Passed as a real argv token so it shows up in `ps -o args=`, which is what
 * the guard reads. A flag the fixture merely *interprets* would not appear
 * there and the listener would look unprotected.
 */
const PROTECTED_MARKER = 'rust-ble-test';

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
});
