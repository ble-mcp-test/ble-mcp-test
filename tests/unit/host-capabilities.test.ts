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

describe('lsof', () => {
  it('is absent when the executable is not on PATH', () => {
    expect(probeCapability(LSOF, { spawn: enoent })).toBe(false);
  });

  it('is present when it runs, whatever it exits with', () => {
    // `lsof -v` exits non-zero on some builds. The question is whether the
    // program is there, not whether that one invocation liked its arguments.
    expect(probeCapability(LSOF, { spawn: () => ran('lsof version 4.95.0', 1) })).toBe(true);
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
    const deps = { spawn: () => ran('100'), readFile: () => '1 (init) S 0 ' + '0 '.repeat(30) };
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
