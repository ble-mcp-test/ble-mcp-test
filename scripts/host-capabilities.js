/**
 * What this repo's scaffolding needs from the host it is running on.
 *
 * ## Why this exists
 *
 * `just validate` is the whole gate. It assumed ONE host role -- the box running
 * the bridge daemon, on Linux -- and the repo now requires a second role that
 * **cannot be the same machine**. Arm B is the only check capable of
 * establishing fidelity, and it needs a host with a real BLE radio of its own:
 * the ESPHome proxy is the bridge's route to the device and Chrome cannot use
 * it. So the gate was red by construction on exactly the hosts that run the only
 * check that matters most, and a permanent baseline of 25 red makes 26 red
 * invisible -- CLAUDE.md's own "a control that cannot usefully go red".
 *
 * ## The rule this file has to obey
 *
 * A quiet skip would be worse than the honest red it replaces: a gate green on a
 * host that ran half of it is CLAUDE.md's second failure class, a silent
 * fallback that looks like configuration. So **the count and the names travel in
 * what the run prints** -- `renderNotRun` below -- exactly as
 * `tests/conformance/arm-status.ts` does for arm B. Nothing here is allowed to
 * make a check disappear without saying its name.
 *
 * ## Why the probes take their dependencies
 *
 * Every probe has two branches and only one of them exists on any given host. A
 * probe verified only where the thing is present would pass identically if it
 * were `() => true`, which is a blanket exemption wearing a probe's costume.
 * Injecting `spawn` and `readFile` is what lets both branches be red on any box.
 * See tests/unit/host-capabilities.test.ts.
 *
 * Plain JS rather than TS because `scripts/pre-test-cleanup.js` runs it outside
 * any TypeScript toolchain, and both sides must derive the answer from ONE
 * declaration rather than from two that agree today.
 */

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { hostname } from 'os';

/** util-linux `flock(1)`. Absent on macOS. */
export const FLOCK = 'flock(1)';

/** A readable Linux `/proc`. Absent on macOS. */
export const PROCFS = '/proc';

/** `getconf CLK_TCK`, the divisor for a `/proc/<pid>/stat` start time. */
export const CLK_TCK = 'getconf CLK_TCK';

/** `lsof`, which is how a listener on a port is identified. */
export const LSOF = 'lsof';

const DEFAULT_DEPS = { spawn: spawnSync, readFile: readFileSync };

const EXEC = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };

/** True when the executable was not there at all, as opposed to having run and failed. */
function notOnPath(result) {
  return Boolean(result && result.error && result.error.code === 'ENOENT');
}

/**
 * The capabilities, each with the sentence printed when it is absent.
 *
 * The reason has to say what is NOT RUNNABLE, not merely what is missing. "no
 * flock" is a fact; "the radio lock IS flock(2) and is Linux-only by design" is
 * the sentence that stops the next operator re-running it on the wrong box.
 */
export const CAPABILITIES = {
  [FLOCK]: {
    because:
      'flock(1) is not on PATH -- macOS does not ship it. The radio lock IS ' +
      'flock(2) on one fixed path, so bin/ble-radio-lock cannot run here at ' +
      'all. Its documented scope is one host; a macOS port is a separate ' +
      'design question (TRA-1257 puts it out of scope).',
    probe: ({ spawn }) => !notOnPath(spawn('flock', ['--help'], EXEC)),
  },
  [PROCFS]: {
    because:
      '/proc is not readable -- macOS has no procfs. Reading a process\'s ' +
      'start time, working directory and argv all go through it, so the ' +
      'staleness guard and the orphan sweep have no way to identify anything.',
    probe: ({ readFile }) => {
      try {
        // The shape callers actually parse: `pid (comm) state ...`, sliced on
        // the LAST ')' because comm can contain spaces and parentheses. A file
        // without one would give a silently wrong start time, so this fails
        // closed on anything that is not a stat line.
        const stat = readFile('/proc/self/stat', 'utf8');
        return stat.includes(')') && /^\d+ \(/.test(stat);
      } catch {
        return false;
      }
    },
  },
  [CLK_TCK]: {
    because:
      'getconf cannot answer CLK_TCK. A /proc start time is in clock ticks ' +
      'since boot, and without the divisor it cannot be turned into a date -- ' +
      'so the bridge staleness verdict has no denominator.',
    probe: ({ spawn }) => {
      const result = spawn('getconf', ['CLK_TCK'], EXEC);
      if (notOnPath(result) || result.status !== 0) return false;
      const value = String(result.stdout ?? '').trim();
      return /^\d+$/.test(value) && Number(value) > 0;
    },
  },
  [LSOF]: {
    because:
      'lsof cannot see a listener that was deliberately opened for it to find. ' +
      'Either it is not on PATH, or it is installed and BLIND: a binary carrying ' +
      'file capabilities runs secure-exec, which makes the process non-dumpable ' +
      'and ptrace-gates /proc/<pid>/fd, so lsof cannot map that process\'s ' +
      'sockets even as the same user. Measured on knuckles 2026-09-06 -- ' +
      '`cap_net_raw=eip` left on the fnm-managed node binary from the Noble era ' +
      'made every test spawning the Node stand-in daemon fail. Remedy: ' +
      'setcap -r "$(readlink -f "$(command -v node)")". The tell is `ss` ' +
      'reporting a listener `lsof` cannot find.',
    // A POSITIVE CONTROL, not a which(1).
    //
    // "lsof is on PATH" is necessary and NOT sufficient, and the gap is not
    // theoretical: on knuckles lsof existed, ran, and could not see a single
    // Node socket. The old probe said `present`, the gate ran the suites, and 13
    // failed exactly as before -- the mechanism built to stop that reported a
    // clean host.
    //
    // `listenerPidsOnPort` reads lsof's exit 1 as "nothing is listening", which
    // is indistinguishable from "cannot see". So the only honest question is the
    // one asked here: open a listener that certainly exists, and check lsof
    // finds it. An empty result is a claim about the query until the query has
    // been shown capable of returning something.
    //
    // The listener is opened by a NODE child on purpose. That is the process
    // class that was blind on knuckles, and a probe that proved lsof could see
    // some other kind of process would have passed there.
    probe: ({ spawn }) => {
      if (notOnPath(spawn('lsof', ['-v'], EXEC))) return false;
      const result = spawn(process.execPath, ['-e', LSOF_SELF_CHECK], EXEC);
      return String(result.stdout ?? '').trim() === 'VISIBLE';
    },
  },
};

/**
 * Run in a child: hold a listening socket open and ask lsof to find it.
 *
 * It has to happen inside one child because `spawnSync` does not return until
 * the child exits -- a parent that spawned a listener and then looked would be
 * looking at a closed socket. So the child opens, looks, and reports.
 *
 * Prints exactly `VISIBLE` or `BLIND`. Anything else (a crash, no node, a
 * timeout) is not `VISIBLE`, and the caller treats that as absent, which is the
 * fail-closed direction: an unusable lsof must not read as a working one.
 */
const LSOF_SELF_CHECK = [
  "const net=require('net');",
  "const {execFileSync}=require('child_process');",
  'const s=net.createServer();',
  "s.listen(0,'127.0.0.1',()=>{",
  '  const port=s.address().port;',
  '  let out="";',
  '  try{',
  "    out=execFileSync('lsof',['-t','-sTCP:LISTEN',`-i:${port}`],",
  "      {encoding:'utf8',stdio:['ignore','pipe','ignore']});",
  '  }catch(e){out="";}',
  '  const mine=out.split(String.fromCharCode(10)).map(x=>x.trim())',
  '    .includes(String(process.pid));',
  "  process.stdout.write(mine?'VISIBLE':'BLIND');",
  '  s.close();',
  '});',
].join('');

/** Every declared capability id. */
export const CAPABILITY_IDS = Object.keys(CAPABILITIES);

function capability(id) {
  const cap = CAPABILITIES[id];
  if (!cap) {
    throw new Error(
      `${JSON.stringify(id)} is not a declared capability. Known: ${CAPABILITY_IDS.join(', ')}`
    );
  }
  return cap;
}

/**
 * Probe `id` now, with no caching.
 *
 * Takes its dependencies so both branches can be exercised anywhere. Callers in
 * anger want `hasCapability`, which memoises -- a probe spawns a process, and
 * the answer cannot change inside one run.
 */
export function probeCapability(id, deps = {}) {
  return capability(id).probe({ ...DEFAULT_DEPS, ...deps });
}

const cache = new Map();

/** Probe `id`, once per process. */
export function hasCapability(id) {
  if (!cache.has(id)) cache.set(id, probeCapability(id));
  return cache.get(id);
}

/**
 * Which of `ids` this host does not have, with the reason for each.
 *
 * An unknown id throws rather than reporting present. A typo that probes as
 * "capable" would leave the gate looking configured and checking nothing, which
 * is the failure class this whole file is defending against.
 */
export function missingCapabilities(ids, deps) {
  return ids
    .filter((id) => !(deps ? probeCapability(id, deps) : hasCapability(id)))
    .map((id) => ({ id, because: capability(id).because }));
}

/** `mssb (linux)`. A result is only meaningful with the host attached to it. */
export function hostDescription() {
  return `${hostname()} (${process.platform})`;
}

/**
 * The banner. Modelled on `tests/conformance/arm-status.ts`, and for the same
 * reason: what is not run has to be legible in the RESULT, because the result is
 * what travels and the config is not.
 *
 * `entries` is `{ what, because }`. An empty list still prints "0 checks NOT
 * RUN" -- an absent section and a zero are different claims, and a reader who
 * sees no section cannot tell whether the banner ran.
 */
export function renderNotRun(heading, entries) {
  const rule = '='.repeat(78);
  const lines = [
    '',
    rule,
    `${heading} on ${hostDescription()}`,
    `  ${entries.length} check${entries.length === 1 ? '' : 's'} NOT RUN on this host` +
      (entries.length === 0 ? ' - nothing was skipped for the host' : ':'),
  ];
  for (const entry of entries) {
    lines.push(`    - ${entry.what}`);
    lines.push(`        ${entry.because}`);
  }
  lines.push(rule, '');
  return lines.join('\n');
}
