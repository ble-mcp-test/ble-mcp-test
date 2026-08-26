import { readFileSync } from 'fs';

export interface PackageMetadata {
  name: string;
  version: string;
  description: string;
}

let cachedMetadata: PackageMetadata | null = null;

/**
 * Resolve this package's manifest.
 *
 * The '../../' is load-bearing and correct in BOTH run modes: this file is at
 * depth 2 as `src/node/package-metadata.ts` (vitest imports the TS directly)
 * and at depth 2 as `dist/node/package-metadata.js` (what consumers resolve
 * through `exports["./node"]`). A single '../' resolves to `dist/package.json`,
 * which does not exist.
 *
 * Called from `connect()` before the socket is constructed, so a wrong path
 * throws ENOENT on connect rather than at import. Keep the call synchronous and
 * ahead of `new WebSocket(...)`.
 */
export function getPackageMetadata(): PackageMetadata {
  if (!cachedMetadata) {
    const packageJsonPath = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    cachedMetadata = {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description
    };
  }
  return cachedMetadata;
}
