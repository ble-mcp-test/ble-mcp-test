import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { VERSION } from '../../src/version.js';

/**
 * `_mv` used to have TWO sources, chosen at runtime by
 * `typeof __PACKAGE_VERSION__ !== 'undefined'`: an esbuild define for the browser
 * bundle, and a synchronous `readFileSync` of package.json for everything else.
 * One contract, two behaviours, selected by how the package happened to be built
 * -- and the filesystem branch made the ESM entry point browser-hostile, because
 * it reaches `fs` from inside connect().
 *
 * Now there is one generated constant. The cost of a generated constant is that
 * it can go stale against its source, so this is the check that both sides derive
 * from -- mechanically, per CLAUDE.md, not by eye. A version bump that forgets
 * `pnpm run version:sync` fails here rather than shipping a bridge a `_mv` that
 * names the wrong release.
 */
describe('the generated version constant', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8')
  );

  it('matches the version in package.json', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('is a non-empty string, not the literal "unknown"', () => {
    // The old getBundleVersion() returned 'unknown' whenever it could not find a
    // window, and 'unknown' reached the bridge as a real-looking `_mv`.
    expect(typeof VERSION).toBe('string');
    expect(VERSION.length).toBeGreaterThan(0);
    expect(VERSION).not.toBe('unknown');
  });
});

/**
 * The generator writes one of its two targets INTO `bridge/src`, which is the
 * directory `scripts/bridge-staleness.js` scans for its mtime leg. So an
 * unconditional write is not a harmless one: `just validate` runs `build` before
 * `test`, and the build's own rewrite of `_version.py` made `pretest` report a
 * STALE BRIDGE for a daemon whose `code_fingerprint` matched the tree exactly.
 * The gate failed itself, and the remedy it printed -- restart the bridge --
 * bought exactly one run before the next build re-armed it.
 *
 * What turns this red: drop the `writeIfChanged` guard in
 * scripts/generate-version.js back to a bare `writeFileSync`. Both mtimes then
 * move on every invocation and both expectations below fail. That is the whole
 * point of asserting on mtime rather than on content -- content is identical in
 * both the fixed and the broken version, so a content check would pass against
 * the bug.
 */
describe('version:sync is idempotent on disk', () => {
  // One base, resolved once. The trailing slash is load-bearing -- `new URL('..', …)`
  // without it resolves the NEXT segment against the parent, so a base built that way
  // would silently produce /src/version.ts instead of <repo>/src/version.ts.
  const rootUrl = new URL('../../', import.meta.url);
  const root = fileURLToPath(rootUrl);
  const targets = ['src/version.ts', 'bridge/src/ble_bridge/_version.py'].map((p) =>
    fileURLToPath(new URL(p, rootUrl))
  );
  const run = () =>
    execFileSync('node', ['scripts/generate-version.js'], { cwd: root, encoding: 'utf8' });
  // Nanosecond precision: two writes inside the same millisecond would compare
  // equal under mtimeMs and hide the regression this guards.
  const mtimes = () => targets.map((t) => statSync(t, { bigint: true }).mtimeNs);

  it('leaves both generated files untouched on a second run', () => {
    run();
    const before = mtimes();
    run();
    expect(mtimes()).toEqual(before);
  });
});
