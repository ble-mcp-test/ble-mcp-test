/**
 * The skip set is asserted, so a check cannot join it quietly.
 *
 * TRA-1257's load-bearing clause. A host-dependent skip is only safe because two
 * things are true at once: the run PRINTS what it did not do, and the set of
 * things it may not do is pinned here. Drop the second and the manifest grows
 * one entry at a time until the gate is green everywhere and means nothing --
 * which is worse than the honest red it replaced.
 *
 * `tests/conformance/arm-a.test.ts` asserts arm A's skip list the same way, for
 * the same reason.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CAPABILITY_IDS,
  CLK_TCK,
  FLOCK,
  LSOF,
  PROCFS,
  hasCapability,
} from '../../scripts/host-capabilities.js';
import {
  HOST_DEPENDENT_SUITES,
  REPO_ROOT,
  gateCallSites,
  gateDescribePairs,
  hostCannotRun,
  hostSkipList,
  renderHostGateReport,
} from '../support/host-gate.js';

const FILES = [...new Set(HOST_DEPENDENT_SUITES.map((s) => s.file))];

describe('the host-dependent skip set', () => {
  it('is not empty, so a green run here is not an empty search', () => {
    expect(HOST_DEPENDENT_SUITES.length).toBeGreaterThan(0);
    expect(FILES.length).toBeGreaterThan(0);
  });

  it('declares each suite exactly once, under a capability that exists', () => {
    const names = HOST_DEPENDENT_SUITES.map((s) => s.suite);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of HOST_DEPENDENT_SUITES) {
      expect(entry.requires.length, `${entry.suite} requires nothing`).toBeGreaterThan(0);
      for (const id of entry.requires) {
        expect(CAPABILITY_IDS, `${entry.suite} requires an unknown capability`).toContain(id);
      }
    }
  });

  it('names files that exist, and suites those files actually contain', () => {
    for (const entry of HOST_DEPENDENT_SUITES) {
      const full = path.join(REPO_ROOT, entry.file);
      expect(existsSync(full), `${entry.file} does not exist`).toBe(true);
      expect(
        readFileSync(full, 'utf8'),
        `${entry.file} has no describe named "${entry.suite}"`,
      ).toContain(`'${entry.suite}'`);
    }
  });

  it('has a call site for every entry, so no entry is a stale leftover', () => {
    const gated = gateCallSites(FILES);
    for (const entry of HOST_DEPENDENT_SUITES) {
      const site = gated.find((g) => g.gate === entry.suite);
      expect(site, `"${entry.suite}" is declared but nothing gates on it`).toBeDefined();
      expect(site!.file, `"${entry.suite}" is declared against the wrong file`).toBe(entry.file);
    }
  });

  it('gates only on the name of the describe it wraps', () => {
    // A gate whose string has drifted from its describe name still skips the
    // right suite -- and the banner then names a suite nobody can find.
    const pairs = gateDescribePairs(FILES);
    expect(pairs.length, 'no describe.skipIf(hostCannotRun(...)) call sites found').toBeGreaterThan(0);
    for (const pair of pairs) {
      expect(pair.describe, `${pair.file}: gate "${pair.gate}" wraps describe "${pair.describe}"`)
        .toBe(pair.gate);
    }
    // Every call site is one of those pairs: a hostCannotRun() hidden in an
    // it.skipIf would gate a check the banner cannot name.
    expect(gateCallSites(FILES).length).toBe(pairs.length);
  });

  it('refuses to gate a suite nobody declared', () => {
    expect(() => hostCannotRun('a suite that does not exist')).toThrow(/HOST_DEPENDENT_SUITES/);
  });
});

/**
 * The gates have to be INERT where the capability is present.
 *
 * "Skips on macOS for lacking flock" must not quietly become "skips
 * everywhere". This is the direction that would turn a portability fix into a
 * blanket exemption, and it is invisible from the host that has the thing
 * unless it is asserted.
 */
describe('a gate is inert on a host that has what it needs', () => {
  it.each(HOST_DEPENDENT_SUITES)('$suite runs iff its capabilities are present', (entry) => {
    const present = entry.requires.every((id) => hasCapability(id));
    expect(hostCannotRun(entry.suite)).toBe(!present);
  });

  it.runIf(process.platform === 'linux')('runs every gated suite on Linux', () => {
    // Linux has flock(1), /proc and getconf CLK_TCK. lsof is a package rather
    // than a kernel feature, so it is asserted separately below.
    for (const id of [FLOCK, PROCFS, CLK_TCK]) {
      expect(hasCapability(id), `${id} should be present on Linux`).toBe(true);
    }
    if (hasCapability(LSOF)) {
      expect(hostSkipList()).toEqual([]);
    }
  });
});

describe('the banner', () => {
  it('names every capability, present or absent', () => {
    const report = renderHostGateReport();
    for (const id of CAPABILITY_IDS) expect(report).toContain(id);
  });

  it('reports the skip set by count and by name', () => {
    const report = renderHostGateReport();
    const skipped = hostSkipList();
    expect(report).toContain(`${skipped.length} check`);
    for (const entry of skipped) {
      expect(report).toContain(entry.what);
      expect(report).toContain(entry.because);
    }
  });
});
