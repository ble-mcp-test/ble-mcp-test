import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getPackageMetadata } from '../../src/package-metadata.js';

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
);

/**
 * The only place in either repo where manifest resolution can fail loudly and
 * unconditionally. It needs no hardware and no bridge, so it runs inside
 * `just validate`.
 *
 * Why it exists: `getPackageMetadata` reads package.json relative to its own
 * compiled location, and the correct number of `../` depends on that depth.
 * The read happens inside `connect()`, so a wrong path throws ENOENT on connect
 * rather than at import -- a filesystem error naming package.json, surfacing in
 * a consumer's specs, saying nothing about this package.
 *
 * Covers the SOURCE mode only: vitest imports the TS from `src/` directly.
 * The compiled `dist/node/` resolution is NOT covered here, because `validate`
 * has no `build` step and `dist/` need not exist when this runs.
 */
describe('getPackageMetadata', () => {
  it('resolves the real manifest, not a placeholder', () => {
    const { name, version } = getPackageMetadata();
    expect(name).toBe(manifest.name);
    expect(version).toBe(manifest.version);
  });

  it('returns a semver-shaped version', () => {
    expect(getPackageMetadata().version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('carries the description through', () => {
    expect(getPackageMetadata().description).toBe(manifest.description);
  });
});
