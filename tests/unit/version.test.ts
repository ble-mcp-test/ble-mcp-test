import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
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
