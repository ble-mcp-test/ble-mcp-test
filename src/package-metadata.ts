import { readFileSync } from 'fs';

export interface PackageMetadata {
  name: string;
  version: string;
  description: string;
}

let cachedMetadata: PackageMetadata | null = null;

/**
 * Resolve this package's manifest. Shared by both clients: the Node
 * test-harness client and the mock's ws-transport, which each stamp the
 * version onto the connect URL as `_mv`.
 *
 * The '../' is load-bearing and correct in BOTH run modes only because this
 * file sits at depth 1: `src/package-metadata.ts` (vitest imports the TS
 * directly) and `dist/package-metadata.js` (published). Move it a directory
 * deeper without changing the path and it resolves to `dist/package.json`,
 * which does not exist.
 *
 * The read happens inside connect(), before the socket is constructed, so a
 * wrong path throws ENOENT on connect rather than at import -- a filesystem
 * error naming package.json, surfacing in a consumer's specs, saying nothing
 * about this package. Keep the call synchronous and ahead of
 * `new WebSocket(...)`.
 */
export function getPackageMetadata(): PackageMetadata {
  if (!cachedMetadata) {
    const packageJsonPath = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    cachedMetadata = {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description
    };
  }
  return cachedMetadata;
}
