export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function formatHex(data: Uint8Array | Buffer): string {
  const bytes = data instanceof Buffer ? data : Buffer.from(data);
  return bytes.toString('hex').toUpperCase().match(/.{2}/g)?.join(' ') || '';
}

export function normalizeLogLevel(level: string | undefined): LogLevel {
  const normalized = (level || 'debug').toLowerCase();
  
  switch (normalized) {
    case 'debug':
    case 'verbose':
    case 'trace':
      return 'debug';
    case 'info':
      return 'info';
    case 'warn':
    case 'warning':
      return 'info'; // Per spec: warn maps to info
    case 'error':
      return 'error';
    default:
      console.warn(`[Config] Unknown log level '${level}', defaulting to debug`);
      return 'debug';
  }
}

import { readFileSync } from 'fs';

let cachedMetadata: { name: string; version: string; description: string } | null = null;

export function getPackageMetadata(): { name: string; version: string; description: string } {
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