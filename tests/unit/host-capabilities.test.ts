/**
 * The host probes, and the two branches each one has.
 *
 * TRA-1257. `just validate` is the whole gate, and CLAUDE.md says it must mean
 * that from any directory. It meant it on ONE host role -- the box running the
 * bridge daemon on Linux -- and the repo now requires a second role that cannot
 * be the same machine: arm B needs a real BLE radio of its own, and the ESPHome
 * proxy is the bridge's route to the device, which Chrome cannot use.
 *
 * The scaffolding that assumed the bridge host is named here rather than
 * discovered: flock(1), /proc, `getconf CLK_TCK`, lsof.
 *
 * ⚠ Every probe is exercised in BOTH directions with injected dependencies.
 * A probe tested only on the host that has the thing asserts a coincidence: it
 * would pass identically if it were `() => true`, and a blanket `true` is a
 * blanket exemption wearing a probe's costume.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CLK_TCK,
  FLOCK,
  LSOF,
  PROCFS,
  hostDescription,
  missingCapabilities,
  probeCapability,
  renderNotRun,
} from '../../scripts/host-capabilities.js';

/** What spawnSync returns when the executable is not on PATH. */
const enoent = () => ({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) });
const ran = (stdout = '', status = 0) => ({ status, stdout, stderr: '' });

describe('the capability catalogue', () => {
  it('gives every capability a reason a reader can act on', () => {
    for (const [id, cap] of Object.entries(CAPABILITIES)) {
      expect(cap.because, `${id} has no reason`).toMatch(/\S/);
      // The reason has to say what is not runnable, not merely what is absent.
      // "no flock" is a fact; "the radio lock is flock(2) and Linux-only" is
      // the sentence that stops someone re-running it on the wrong box.
      expect(cap.because.length, `${id}'s reason is too short to be a reason`).toBeGreaterThan(40);
    }
  });

  it('names itself and the platform, so a result carries the host it came from', () => {
    expect(hostDescription()).toMatch(new RegExp(`\\(${process.platform}\\)`));
  });
});

describe('flock(1)', () => {
  it('is absent when the executable is not on PATH', () => {
    expect(probeCapability(FLOCK, { spawn: enoent })).toBe(false);
  });

  it('is present when it runs', () => {
    expect(probeCapability(FLOCK, { spawn: () => ran('Usage: flock ...') })).toBe(true);
  });
});

describe('/proc', () => {
  it('is absent when /proc/self/stat cannot be read', () => {
    const readFile = () => { throw new Error('ENOENT'); };
    expect(probeCapability(PROCFS, { readFile })).toBe(false);
  });

  it('is absent when the read gives something that is not a stat line', () => {
    // Fails CLOSED on a surprise. `processStartedAt` slices on the last ')',
    // so a file with no comm field would yield a silently wrong start time.
    expect(probeCapability(PROCFS, { readFile: () => 'not a stat line' })).toBe(false);
  });

  it('is present for a real stat line', () => {
    const readFile = () => '1 (systemd) S 0 1 1 0 -1 4194560 ' + '0 '.repeat(30);
    expect(probeCapability(PROCFS, { readFile })).toBe(true);
  });
});

describe('getconf CLK_TCK', () => {
  it('is absent when getconf is not on PATH', () => {
    expect(probeCapability(CLK_TCK, { spawn: enoent })).toBe(false);
  });

  it('is absent when getconf does not know the variable', () => {
    // macOS ships getconf, so ENOENT is not the only way this goes missing --
    // an unknown variable exits non-zero and prints prose. Treating "getconf
    // exists" as "CLK_TCK answerable" would make the probe true on a host where
    // processStartedAt cannot work.
    expect(probeCapability(CLK_TCK, { spawn: () => ran('getconf: unknown variable', 1) })).toBe(false);
  });

  it('is absent for a zero, which would divide the start time by nothing', () => {
    expect(probeCapability(CLK_TCK, { spawn: () => ran('0') })).toBe(false);
  });

  it('is present for a usable tick count', () => {
    expect(probeCapability(CLK_TCK, { spawn: () => ran('100\n') })).toBe(true);
  });
});

/**
 * lsof is probed by POSITIVE CONTROL, and these pin both halves.
 *
 * "lsof is on PATH" is necessary and not sufficient. On knuckles (2026-09-06)
 * lsof existed, ran, and could not see a single Node socket: `cap_net_raw=eip`
 * on the fnm-managed node binary made those processes non-dumpable, which
 * ptrace-gates `/proc/<pid>/fd`. The old probe answered `present`, the gate ran
 * the suites, and 13 failed exactly as before.
 *
 * ⚠ The blind branch is NOT reproducible here -- setting file capabilities needs
 * root and a real binary. It was observed in the wild on knuckles and is
 * exercised below by injection. Said plainly rather than implied, because a
 * green run on this box is not evidence that a blind host is detected.
 */
describe('lsof', () => {
  /** Distinguishes the two spawns the probe makes: `lsof -v`, then the child. */
  const answering = (verdict: string) => (cmd: string) =>
    cmd === 'lsof' ? ran('lsof version 4.95.0', 1) : ran(verdict);

  it('is absent when the executable is not on PATH', () => {
    expect(probeCapability(LSOF, { spawn: enoent })).toBe(false);
  });

  it('is present when it finds a listener opened for it to find', () => {
    // `lsof -v` exits non-zero on some builds, so the first call's status is
    // deliberately 1 here -- the verdict comes from the control, not from that.
    expect(probeCapability(LSOF, { spawn: answering('VISIBLE') })).toBe(true);
  });

  it('is ABSENT when lsof runs but cannot see our own listener', () => {
    // The knuckles case. This is the whole reason the probe is not a which(1):
    // every other signal here says lsof is fine.
    expect(probeCapability(LSOF, { spawn: answering('BLIND') })).toBe(false);
  });

  it('is absent when the control says nothing at all', () => {
    // A crashed child, a missing node, a timeout. Fail closed: an lsof that
    // cannot be shown to work must not read as one that does.
    expect(probeCapability(LSOF, { spawn: answering('') })).toBe(false);
  });

  it('takes its verdict from the control, not from `lsof -v`', () => {
    // `lsof -v` printing VISIBLE must not satisfy the probe on its own -- that
    // would be the check satisfied by a subject other than the one it is about,
    // which is the shape the whole positive control exists to close.
    const lsofLooksFineButIsBlind = (cmd: string) =>
      cmd === 'lsof' ? ran('VISIBLE') : ran('BLIND');
    expect(probeCapability(LSOF, { spawn: lsofLooksFineButIsBlind })).toBe(false);
  });
});

describe('missingCapabilities', () => {
  it('returns the absent ones with their reasons, and nothing for the present ones', () => {
    const deps = { spawn: enoent, readFile: () => 'not a stat line' };
    const missing = missingCapabilities([FLOCK, PROCFS], deps);
    expect(missing.map((m) => m.id)).toEqual([FLOCK, PROCFS]);
    expect(missing[0].because).toBe(CAPABILITIES[FLOCK].because);
  });

  it('is empty when everything asked for is present', () => {
    // lsof needs its control to answer VISIBLE; getconf needs a tick count. One
    // stub cannot say both, so it answers per command -- which is also a
    // reminder that these probes ask different questions.
    const deps = {
      spawn: (cmd: string, args: string[]) =>
        cmd === process.execPath || (args ?? []).includes('-e') ? ran('VISIBLE') : ran('100'),
      readFile: () => '1 (init) S 0 ' + '0 '.repeat(30),
    };
    expect(missingCapabilities([FLOCK, PROCFS, CLK_TCK, LSOF], deps)).toEqual([]);
  });

  it('refuses a capability nobody declared, rather than reporting it present', () => {
    // A typo'd id that silently probes as "present" is the whole failure class:
    // the gate would look configured and check nothing.
    expect(() => missingCapabilities(['flcok'])).toThrow(/not a declared capability/);
  });
});

describe('renderNotRun', () => {
  it('says nothing was skipped, by count, rather than printing nothing at all', () => {
    // An absent section is not the same claim as "0 skipped". The count is what
    // travels; a reader who sees no section cannot tell the banner ran.
    const out = renderNotRun('PRETEST', []);
    expect(out).toContain('0 checks NOT RUN');
  });

  it('names each skipped check and its reason, in what the run prints', () => {
    const out = renderNotRun('PRETEST', [
      { what: 'orphaned test-runner sweep', because: 'no /proc on this host' },
    ]);
    expect(out).toContain('1 check NOT RUN');
    expect(out).toContain('orphaned test-runner sweep');
    expect(out).toContain('no /proc on this host');
  });
});
