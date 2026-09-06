/**
 * The radio lock: a hold that spans a whole operation.
 *
 * TRA-1241. On 2026-08-31 two sessions collided on the CS108 while `held: false`
 * was reporting the truth the whole time -- a publish released the device between
 * its gate run and its OTP retry, and a poll landed in the 26-second gap. The fix
 * is not a better flag. It is a hold that outlives every attempt inside one
 * operation, and that the kernel takes back when its holder dies.
 *
 * These tests never touch a radio. The lock is a file, which is the point:
 * nothing here depends on the bridge, a WS connection, or a device.
 */
import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../../bin/ble-radio-lock', import.meta.url));

/** EX_TEMPFAIL. The lock is held by someone else and we refused rather than queued. */
const EXIT_RADIO_BUSY = 75;

function freshLockPath(): string {
  return join(tmpdir(), `radio-lock-test-${randomUUID()}.lock`);
}

function run(args: string[], lock: string) {
  return spawnSync(TOOL, args, {
    encoding: 'utf8',
    env: { ...process.env, BLE_MCP_RADIO_LOCK: lock },
  });
}

/**
 * Start a holder and do not return until it actually owns the lock.
 *
 * Returns the child so the caller can kill it. Waiting on the sidecar rather
 * than on a sleep is deliberate: a fixed delay here would make every assertion
 * downstream a race, and a racing test that passes is the thing this repo calls
 * a coincidence.
 */
async function startHolder(
  lock: string,
  args: string[] = ['--label', 'test-holder', '--', 'sleep', '10'],
) {
  const child = spawn(TOOL, args, {
    env: { ...process.env, BLE_MCP_RADIO_LOCK: lock },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(`${lock}.holder`)) return child;
    await new Promise((r) => setTimeout(r, 20));
  }
  child.kill('SIGKILL');
  throw new Error('holder never acquired the lock within 5s');
}

describe('ble-radio-lock', () => {
  it('runs the wrapped command and propagates success', () => {
    const lock = freshLockPath();
    const result = run(['--', 'sh', '-c', 'echo ran-under-lock'], lock);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ran-under-lock');
  });

  it('propagates the wrapped command\'s non-zero exit code', () => {
    const lock = freshLockPath();
    const result = run(['--', 'sh', '-c', 'exit 42'], lock);

    // Not 0, and not 75 either -- a failing operation must not be mistaken for
    // a refused one by whatever is reading the exit code.
    expect(result.status).toBe(42);
  });

  it('refuses a contended acquire immediately rather than queueing behind it', async () => {
    const lock = freshLockPath();
    const holder = await startHolder(lock);
    try {
      const started = Date.now();
      const result = run(['--', 'sh', '-c', 'echo should-not-run'], lock);
      const elapsed = Date.now() - started;

      expect(result.status).toBe(EXIT_RADIO_BUSY);
      expect(result.stdout).not.toContain('should-not-run');
      // The holder is mid-`sleep 10`. Blocking would show up here as ~10000.
      expect(elapsed).toBeLessThan(2000);
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('names the holder and the lock path when it refuses', async () => {
    const lock = freshLockPath();
    const holder = await startHolder(lock);
    try {
      const result = run(['--', 'true'], lock);

      expect(result.status).toBe(EXIT_RADIO_BUSY);
      expect(result.stderr).toContain('test-holder');
      // The path is in the message because two sides pointed at different lock
      // files is the one bug that makes this whole mechanism silently absent.
      expect(result.stderr).toContain(lock);
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('comes back on its own when the holder is SIGKILLed', async () => {
    const lock = freshLockPath();
    const holder = await startHolder(lock);

    // Confirm it is genuinely held first, so that the acquire below is evidence
    // of release rather than evidence that nothing ever held it.
    expect(run(['--', 'true'], lock).status).toBe(EXIT_RADIO_BUSY);

    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.on('exit', resolve));

    const afterDeath = run(['--', 'sh', '-c', 'echo acquired-after-death'], lock);
    expect(afterDeath.status).toBe(0);
    expect(afterDeath.stdout).toContain('acquired-after-death');
  });

  it('resolves to one fixed path with no computed fallback', () => {
    const env = { ...process.env };
    delete env.BLE_MCP_RADIO_LOCK;
    delete env.XDG_RUNTIME_DIR;

    const withoutRuntimeDir = spawnSync(TOOL, ['path'], { encoding: 'utf8', env });
    const withRuntimeDir = spawnSync(TOOL, ['path'], {
      encoding: 'utf8',
      env: { ...env, XDG_RUNTIME_DIR: '/run/user/9999' },
    });

    // Both repos must land on the same file without coordinating. A path
    // computed from the environment is this codebase's second named failure
    // class -- it would look configured and lock nothing.
    expect(withoutRuntimeDir.stdout.trim()).toBe('/tmp/ble-mcp-test.radio.lock');
    expect(withRuntimeDir.stdout.trim()).toBe('/tmp/ble-mcp-test.radio.lock');
  });

  it('still refuses, and claims no holder it cannot verify, when the sidecar is stale', async () => {
    const lock = freshLockPath();

    // Hold it with flock(1) directly -- no sidecar is written. This also proves
    // the documented contract: the mechanism is flock(2) on the path, so a
    // holder that never heard of this script still excludes us.
    const raw = spawn('flock', ['-n', lock, 'sleep', '10'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300));

    // A lie left behind by an earlier, long-dead holder.
    writeFileSync(`${lock}.holder`, 'pid=999999\nlabel=ghost\nsince=2026-01-01T00:00:00Z\n');

    try {
      const result = run(['--', 'true'], lock);

      expect(result.status).toBe(EXIT_RADIO_BUSY);
      expect(result.stderr).toContain(lock);
      // It must not report "ghost" as the holder: that pid is dead, so the
      // sidecar is stale and the real holder is unidentified. Saying so is the
      // honest answer; naming ghost would send someone chasing a dead process.
      expect(result.stderr).not.toContain('ghost');
      expect(result.stderr.toLowerCase()).toContain('unidentified');
    } finally {
      raw.kill('SIGKILL');
      rmSync(`${lock}.holder`, { force: true });
    }
  });
});
