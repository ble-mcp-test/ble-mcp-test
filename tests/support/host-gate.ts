/**
 * Which suites this host cannot run, and the line that says so.
 *
 * TRA-1257. The precedent is one directory away: `tests/conformance/arm-status.ts`
 * does not fail a check the provider cannot run, and does not silently drop it
 * either -- it reports it NOT RUN **by name, with a reason**, in what the run
 * prints. Same idiom here, for the host rather than for the provider.
 *
 * ## Two rules, and the second is the load-bearing one
 *
 * 1. A gated suite names the capabilities it needs, and `hostCannotRun` THROWS
 *    on a name that is not in the manifest below. So a suite cannot join the
 *    skip set without an entry appearing in this file, where review sees it.
 * 2. The skip set is printed, with reasons, by `renderHostGateReport` --
 *    installed as vitest's globalSetup. A gate that goes green on a host that
 *    ran half of it is worse than the honest red it replaced: that is
 *    CLAUDE.md's second failure class, a silent fallback that looks like
 *    configuration.
 *
 * ## What is deliberately NOT in here
 *
 * Portability is not a blanket exemption. Each entry lists the capabilities it
 * actually needs, so a suite gated for lacking `flock(1)` still runs -- and can
 * still go red -- on every host that has it. `tests/unit/host-gate.test.ts`
 * asserts that the gates are inert on this host when the capability is present.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CAPABILITY_IDS,
  CLK_TCK,
  FLOCK,
  LSOF,
  PROCFS,
  hasCapability,
  missingCapabilities,
  renderNotRun,
} from '../../scripts/host-capabilities.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface GatedSuite {
  /** Repo-relative path of the file the `describe` lives in. */
  file: string;
  /** The `describe` name, verbatim. */
  suite: string;
  /** Capability ids from scripts/host-capabilities.js. */
  requires: string[];
}

/**
 * Every suite whose ability to run depends on the host.
 *
 * Kept at `describe` granularity rather than per file: the files below each
 * hold portable checks alongside host-dependent ones, and skipping a whole file
 * for one `flock` call would retire coverage that works everywhere.
 */
export const HOST_DEPENDENT_SUITES: GatedSuite[] = [
  // The radio lock IS flock(2) on one fixed path. Its documented scope is one
  // host, and a macOS port is a separate design question.
  { file: 'tests/unit/radio-lock.test.ts', suite: 'ble-radio-lock', requires: [FLOCK] },
  // Nesting additionally walks /proc to decide whether a pid is an ancestor.
  { file: 'tests/unit/radio-lock.test.ts', suite: 'ble-radio-lock nesting', requires: [FLOCK, PROCFS] },

  // A start time is /proc/<pid>/stat field 22 divided by CLK_TCK; a checkout is
  // /proc/<pid>/cwd.
  {
    file: 'tests/unit/bridge-staleness.test.ts',
    suite: 'reading a running process out of /proc',
    requires: [PROCFS, CLK_TCK],
  },
  // "Nothing is listening" is answered by lsof alone -- no process is inspected.
  {
    file: 'tests/unit/bridge-staleness.test.ts',
    suite: 'assertBridgeCurrent with nothing on the port',
    requires: [LSOF],
  },
  { file: 'tests/unit/bridge-staleness.test.ts', suite: 'assertBridgeCurrent', requires: [LSOF, PROCFS, CLK_TCK] },
  {
    file: 'tests/unit/bridge-staleness.test.ts',
    suite: 'pre-test-cleanup.js wiring',
    requires: [LSOF, PROCFS, CLK_TCK],
  },

  // The /proc-absent branches are faked with injected deps, so only lsof is a
  // real requirement: two of the three need a listener to be findable.
  {
    file: 'tests/unit/bridge-staleness.test.ts',
    suite: 'assertBridgeCurrent on a host without /proc',
    requires: [LSOF],
  },

  // killPort identifies its victim from /proc/<pid>/cmdline, having found it
  // with lsof. Both, or it refuses to kill anything.
  { file: 'tests/unit/pre-test-cleanup.test.ts', suite: 'killPort', requires: [LSOF, PROCFS] },
  { file: 'tests/unit/pre-test-cleanup.test.ts', suite: 'pre-test-cleanup.js', requires: [LSOF, PROCFS] },
];

function entryFor(suite: string): GatedSuite {
  const matches = HOST_DEPENDENT_SUITES.filter((s) => s.suite === suite);
  if (matches.length !== 1) {
    throw new Error(
      `"${suite}" has ${matches.length} entries in HOST_DEPENDENT_SUITES (tests/support/host-gate.ts). ` +
        'A suite gated on the host must be declared there exactly once, so that the run can print ' +
        'it by name when it does not run.'
    );
  }
  return matches[0];
}

/**
 * True when this host lacks something the suite needs.
 *
 * Throws for a suite that is not declared, which is what stops a check joining
 * the skip set quietly.
 */
export function hostCannotRun(suite: string): boolean {
  return missingCapabilities(entryFor(suite).requires).length > 0;
}

export interface NotRunEntry {
  what: string;
  because: string;
}

/** The suites this host will not run, in the shape `renderNotRun` prints. */
export function hostSkipList(): NotRunEntry[] {
  const out: NotRunEntry[] = [];
  for (const entry of HOST_DEPENDENT_SUITES) {
    const missing = missingCapabilities(entry.requires);
    if (missing.length === 0) continue;
    out.push({
      what: `${entry.suite}  (${entry.file})`,
      because:
        `needs ${missing.map((m) => m.id).join(' and ')}. ` +
        missing.map((m) => m.because).join(' '),
    });
  }
  return out;
}

/**
 * The banner. Prints the probe results as well as the skip list: a reader
 * looking at a green run on an unfamiliar host needs to see WHY it was whole,
 * not only that nothing was dropped.
 */
export function renderHostGateReport(): string {
  const probes = CAPABILITY_IDS.map(
    (id) => `  ${hasCapability(id) ? 'present' : 'ABSENT '}  ${id}`
  ).join('\n');
  return `${probes}\n${renderNotRun('VITEST HOST GATE', hostSkipList())}`;
}

/**
 * Every `hostCannotRun('…')` in the given files, whatever it is wrapped in.
 *
 * Deliberately broader than the `describe.skipIf` form: the point of the scan is
 * to catch a call site the manifest does not know about, and one hidden inside
 * an `it.skipIf` would be exactly that.
 */
export function gateCallSites(files: string[]): Array<{ file: string; gate: string }> {
  const sites: Array<{ file: string; gate: string }> = [];
  for (const file of files) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const m of text.matchAll(/hostCannotRun\('([^']+)'\)/g)) {
      sites.push({ file, gate: m[1] });
    }
  }
  return sites;
}

/** The `describe.skipIf(hostCannotRun('X'))('Y', …)` pairs, so X and Y can be compared. */
export function gateDescribePairs(files: string[]): Array<{ file: string; gate: string; describe: string }> {
  const pattern = /describe\.skipIf\(\s*hostCannotRun\('([^']+)'\)\s*\)\(\s*'([^']+)'/g;
  const pairs: Array<{ file: string; gate: string; describe: string }> = [];
  for (const file of files) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const m of text.matchAll(pattern)) {
      pairs.push({ file, gate: m[1], describe: m[2] });
    }
  }
  return pairs;
}
