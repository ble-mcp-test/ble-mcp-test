import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';

/**
 * TRA-1219 item 3: give `CONTRIBUTING.md` a consumer.
 *
 * Items 1 and 2 of that ticket are symptoms. This is the cause: **nothing reads
 * CONTRIBUTING.md.** No gate, no session, no CI, and evidently no human -- this
 * repo's copy told a contributor to
 * `git clone .../web-ble-bridge.git && cd web-ble-bridge` long after the package
 * was renamed `ble-mcp-test`, so step 2 of the documented path 404'd. The README
 * three lines away stayed correct, because people open the README.
 *
 * It did not rot through carelessness. It rotted because nothing ever
 * contradicted it. So: something now contradicts it.
 *
 * ## Why a vitest file and not a CI job
 *
 * The sibling repos wired their equivalents into CI. **This repo has no CI** --
 * no `.github/workflows/` at all -- so a CI-shaped gate here would be a gate
 * that never runs. `just validate` is the whole gate, and it runs vitest, so
 * this is where a check has to live to actually fire.
 *
 * ## Why the matching is deliberately narrow
 *
 * infra's equivalent found **86 false positives** with the obvious rule ("a
 * token containing a slash is a path") -- prose like `N/A`, `preview/prod`,
 * image refs, IAM roles. Their conclusion is the one worth keeping: *a gate that
 * noisy gets ignored, which is exactly how the file it checks rotted.*
 *
 * So a token is only checked when all three hold:
 *   - it contains a `/` -- excludes bare mentions like `mock-bluetooth.ts`,
 *     which name a file without claiming a location
 *   - its last segment has a file extension -- excludes `feat/add-reconnect`
 *     and other slash-bearing prose
 *   - its first segment is a real top-level entry, read from the tree at run
 *     time -- excludes anything that merely looks path-shaped
 *
 * Scoped to CONTRIBUTING.md rather than all docs, for the same reason: this is
 * the file with the demonstrated failure. Widening it is a separate decision
 * with its own false-positive budget.
 */
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const contributing = readFileSync(new URL('../../CONTRIBUTING.md', import.meta.url), 'utf8');

/** Top-level entries of the repo, read now rather than hardcoded. */
const topLevel = new Set(readdirSync(projectRoot));

/**
 * `pnpm` subcommands that are not package scripts.
 *
 * Without this the check fails on `pnpm install`, which is correct advice and
 * not a script -- a gate that fails on a correct file is a gate someone turns
 * off.
 */
const PNPM_BUILTINS = new Set([
  'install', 'i', 'add', 'remove', 'dlx', 'exec', 'run', 'pack', 'why', 'update', 'link'
]);

describe('CONTRIBUTING.md instructions still resolve', () => {
  it('every `pnpm <script>` it names is a real package script', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const scripts = new Set(Object.keys(pkg.scripts ?? {}));

    const named = [...contributing.matchAll(/\bpnpm\s+([a-z][a-z0-9:_-]*)/g)]
      .map((m) => m[1])
      .filter((s) => !PNPM_BUILTINS.has(s));

    const missing = [...new Set(named)].filter((s) => !scripts.has(s));
    expect(missing, `CONTRIBUTING.md names pnpm scripts that package.json does not define`).toEqual([]);
  });

  it('every `just <recipe>` it names is a real recipe', () => {
    const justfile = readFileSync(new URL('../../justfile', import.meta.url), 'utf8');
    const recipes = new Set(
      [...justfile.matchAll(/^([a-z][a-z0-9_-]*)(?:\s+[^:]*)?:/gm)].map((m) => m[1])
    );

    const named = [...new Set([...contributing.matchAll(/\bjust\s+([a-z][a-z0-9_-]*)/g)].map((m) => m[1]))];
    const missing = named.filter((r) => !recipes.has(r));
    expect(missing, `CONTRIBUTING.md names just recipes the justfile does not define`).toEqual([]);
  });

  it('every repo-relative path it names exists', () => {
    const candidates = [...new Set([...contributing.matchAll(/`([^`\s]+\/[^`\s]+)`/g)].map((m) => m[1]))]
      // last segment must carry an extension
      .filter((p) => /\.[a-z0-9]+$/i.test(p.split('/').pop() ?? ''))
      // first segment must be a real top-level entry
      .filter((p) => topLevel.has(p.split('/')[0]));

    const missing = candidates.filter((p) => !existsSync(new URL(`../../${p}`, import.meta.url)));
    expect(missing, `CONTRIBUTING.md names repo paths that do not exist`).toEqual([]);
  });

  it('the clone URL names this repo', () => {
    // The specific failure TRA-1219 found here. `no-dead-server-instructions`
    // forbids the old name; this asserts the positive, so a THIRD name would be
    // caught too rather than only a return of the known-dead one.
    const clone = contributing.match(/git clone https:\/\/github\.com\/[^/]+\/([^\s.]+)\.git/);
    expect(clone, 'CONTRIBUTING.md should show a git clone command').not.toBeNull();
    expect(clone?.[1]).toBe('ble-mcp-test');
  });
});
