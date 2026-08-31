import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

/**
 * TRA-1186 item 3: the guard that makes this the last time.
 *
 * The 8080 -> 25153 move was verified in the CODE and missed everywhere else,
 * because the only regression guard read `.env.local.example` -- the one file
 * that could not drift. Docs, scripts and examples were never checked, so they
 * kept instructing readers to point the bridge at a port the platform backend
 * already publishes on 0.0.0.0:8080. Following those guides hand-recreates the
 * exact collision the move removed, and it presents as a dead reader rather
 * than as a port conflict.
 *
 * The same sweep left a second class behind: instructions for the TypeScript
 * server that 0.8.0 deleted. `dist/start-server.js`, `--mcp-http`, `MCP_TOKEN`
 * and the `:8081/health` endpoint are all gone. What makes those worse than
 * merely stale is HOW they fail -- a script that starts nothing while printing
 * green steps, and a health check against an endpoint the Python bridge does
 * not serve, which reads as "the bridge is down" rather than "this URL never
 * existed."
 *
 * So this asserts over TRACKED files, not the working tree: build output,
 * node_modules and the 399MB of gitignored Rust spike leftovers are not this
 * repo's claims about itself.
 *
 * ## Why there is an opt-out rather than a file allowlist
 *
 * A growing exclusion list is how a guard stops guarding -- each addition looks
 * local and reasonable, and nobody re-reads the set. Instead a line may carry
 * the marker below, which forces the writer to say "this is history" in the
 * line itself, where the next reader sees it.
 */
const HISTORY_MARKER = 'tra-1186-historical';

/**
 * Each pattern is a claim the repo must not make about itself.
 *
 * Deliberately NOT included: `scan_devices`, `get_metrics` and friends. Those
 * appear in `bridge/tests/` and `docs/MCP-SERVER.md` as assertions that the
 * tool is ABSENT -- `assert "scan_devices" not in names`. A guard that cannot
 * tell "we removed this" from "use this" would fire on the tests that prove the
 * removal, which is the opposite of the job.
 */
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; why: string; appliesTo?: RegExp }> = [
  {
    pattern: /localhost:8080/,
    why: 'the bridge moved to 25153 (TRA-1179); 8080 is the platform BACKEND, and pointing the bridge there recreates the collision'
  },
  {
    pattern: /localhost:8081/,
    why: 'the :8081 HTTP transport and its /health endpoint were deleted with the TypeScript server (TRA-1161); the Python bridge serves neither'
  },
  {
    pattern: /dist\/start-server\.js/,
    why: 'the server binary was deleted in 0.8.0 -- this repo publishes two client entry points and no server'
  },
  {
    pattern: /--mcp-http/,
    why: 'the HTTP transport was replaced by a unix socket (TRA-1161); the flag does not exist'
  },
  {
    pattern: /MCP_TOKEN/,
    why: 'authentication died with the HTTP transport (TRA-1161); the socket is mode 0600, owner only'
  },
  {
    // A knob that was accepted, defaulted, copied into the connect options,
    // LOGGED, and read by nothing. `injectWebBluetoothMock({timeout})` reached
    // `bleConfig.timeout` and stopped there: `WebSocketTransport.connect()` has
    // no `timeout` parameter and bounds the handshake with a hardcoded 10000ms.
    //
    // What makes it worse than an unimplemented option is the log line. Every
    // connect printed `{..."timeout":5000...}` -- the DEFAULT, for a field the
    // caller had not set -- at the moment the value was discarded. It did not
    // merely advertise a dead knob, it fabricated the appearance of a caller
    // decision nobody had made, and two sessions spent real time reasoning
    // about why "the client asked for 5000" (TRA-1189, 2026-08-29).
    //
    // Deleted rather than wired up: real `gatt.connect()` takes no timeout
    // argument, so honouring it would be a divergence from the API this mock
    // exists to double -- and the 5000 default would have made the unset case
    // abandon EARLIER than the 10s it actually waited.
    pattern: /OPTIONAL\s*-\s*discovery timeout|Optional: connection timeout|Device discovery timeout/i,
    why: 'the mock config never had a working `timeout`; it was read by nothing and deleted in TRA-1189. Real gatt.connect() takes no timeout argument'
  },
  {
    // Same failure shape as the ports above: a documented value that no longer
    // works. 0.8.0 made the mock canonicalise UUIDs the way real Chromium does,
    // so a short form now throws a TypeError at argument validation rather than
    // being quietly accepted -- and every doc that showed `9800` sent the reader
    // into that throw on their first getCharacteristic.
    pattern: /BLE_MCP_(?:SERVICE|WRITE|NOTIFY)_UUID\s*[=:]\s*'?"?[0-9a-fA-Fx]{2,8}\b(?!-)/,
    why: 'since 0.8.0 the mock rejects short-form UUIDs; docs must show the full lowercase 128-bit form',
    // Documentation and copy-paste sources only. A test that assigns '9800' to
    // an env var is exercising config plumbing, not instructing anyone -- and a
    // guard that cannot tell a fixture from an instruction would force test
    // authors to write 36-character UUIDs to satisfy a rule about prose.
    appliesTo: /\.(md|html)$/
  },
  {
    // The package was renamed `@trakrf/web-ble-bridge` -> `ble-mcp-test`, a
    // BREAKING change recorded in CHANGELOG.md. `CONTRIBUTING.md` kept the old
    // name in four load-bearing places: its title, its description, its
    // `git clone` URL and its "open a PR" link -- the last pointing at
    // `github.com/trakrf/web-ble-bridge`, which is the wrong org AND the wrong
    // name for a repo that lives at `ble-mcp-test/ble-mcp-test`.
    //
    // So step 2 of the documented contributor path 404s. It failed the way
    // TRA-1219 describes: nothing reads CONTRIBUTING.md, so nothing ever
    // contradicted it. The README next to it stayed correct because people
    // actually open the README.
    //
    // CHANGELOG.md and dated design docs are already skipped by isHistory(),
    // which is where the rename is legitimately recorded.
    pattern: /web-ble-bridge/,
    why: 'the package was renamed to `ble-mcp-test` (see CHANGELOG); the old name 404s as a repo URL and names a package that no longer exists (TRA-1219)'
  }
];

/** This file. A guard cannot assert about the file that declares what it forbids. */
const SELF = 'tests/unit/no-dead-server-instructions.test.ts';

/**
 * Files whose whole purpose is to record what used to be true, plus this one.
 *
 * The self-exclusion is not a convenience: every pattern above appears in this
 * file by necessity, so without it the guard fails on itself and the only way to
 * make it pass would be to weaken the patterns. It went unnoticed until the file
 * was committed, because `git ls-files` does not list untracked files -- so the
 * first green run had simply not looked here. That is the same self-match shape
 * as `pgrep -f X` matching the shell that ran it.
 */
function isHistory(path: string): boolean {
  return path === SELF || path === 'CHANGELOG.md' || /^docs\/design\/\d{4}-\d{2}-\d{2}-/.test(path);
}

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Extensions that cannot carry an instruction to a human: binaries, images,
 * fonts, and lock files whose contents nobody reads or follows.
 *
 * ## Why this is a DENY list and not an ALLOW list
 *
 * It was an allow list — `.ts|.js|.md|.sh|.html|.json|.py|.yaml|.yml` — and that
 * silently excluded every EXTENSIONLESS tracked file: `justfile`,
 * `bridge/justfile`, `.envrc`, `CODEOWNERS`, and **`.env.local.example`**, which
 * is the file TRA-1186 is actually about. So the guard could report "no live
 * references" having never opened the ticket's own subject.
 *
 * That is the fourth time this exact move landed in this ticket's lineage, each
 * repair reintroducing it one level inside the last:
 *
 *     TRA-1179  fixed the code       -> scoped the guard to .env.local.example
 *     #600      fixed two docs       -> scoped the guard to those two docs
 *     #74       fixed the file list  -> scoped the SCAN to known extensions
 *     this      fixed the scan       -> describes only what is EXCLUDED
 *
 * **An allow list can always be partially applied; an exclusion cannot.** A new
 * file type joins the scan by default and has to be argued OUT, which is the
 * only direction that fails safe. Same family as identifying a process by the
 * port it listens on rather than by a name in its argv.
 *
 * The platform session hit the identical bug in their mirror of this guard, in
 * the same hours, while warning me about mine.
 */
const UNREADABLE = /\.(png|jpe?g|gif|ico|svg|woff2?|ttf|eot|pdf|zip|tgz|gz|whl|so|bin|wasm|webm|mp4|lock)$/i;

/** Lock files by name, since some carry a readable extension. */
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'uv.lock', 'bridge/uv.lock']);

/**
 * Every tracked file the guard can meaningfully read.
 *
 * `-z` because git C-style-quotes any path containing a space or a non-ASCII
 * byte, and a quoted path would not open.
 */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: projectRoot, encoding: 'utf-8' });
  return out
    .split('\0')
    .filter(Boolean)
    .filter(p => !UNREADABLE.test(p) && !LOCKFILES.has(p));
}

describe('the repo does not instruct anyone to use the deleted server', () => {
  const files = trackedFiles();

  it('finds tracked files to check at all', () => {
    // Without this, a broken `git ls-files` makes every assertion below vacuous
    // and the suite reports green having checked nothing.
    expect(files.length).toBeGreaterThan(50);
  });

  for (const { pattern, why, appliesTo } of FORBIDDEN) {
    it(`has no live reference to ${pattern.source} -- ${why}`, () => {
      const offenders: string[] = [];

      for (const file of files) {
        if (isHistory(file)) continue;
        if (appliesTo && !appliesTo.test(file)) continue;
        let content: string;
        try {
          content = readFileSync(projectRoot + file, 'utf-8');
        } catch {
          continue; // deleted between ls-files and here
        }
        content.split('\n').forEach((line, i) => {
          if (pattern.test(line) && !line.includes(HISTORY_MARKER)) {
            offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
          }
        });
      }

      expect(offenders, `\n${why}\nMark a genuinely historical line with "${HISTORY_MARKER}".\n`).toEqual([]);
    });
  }
});
