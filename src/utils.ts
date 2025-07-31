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

// UUID normalization for Noble.js (moved from noble-transport.ts)
export function normalizeUuid(uuid: string): string {
  const isLinux = process.platform === 'linux';
  
  // Remove dashes and convert to lowercase
  const cleaned = uuid.toLowerCase().replace(/-/g, '');
  
  if (isLinux) {
    // Linux: Always convert to full 128-bit UUID without dashes
    
    // If already 32 chars (full UUID without dashes), return as-is
    if (cleaned.length === 32) return cleaned;
    
    // If 4-char short UUID, expand to full 128-bit without dashes
    if (cleaned.length === 4) {
      return `0000${cleaned}00001000800000805f9b34fb`;
    }
    
    // Handle other lengths by padding and taking last 4 chars
    const shortId = cleaned.padStart(4, '0').slice(-4);
    return `0000${shortId}00001000800000805f9b34fb`;
  } else {
    // macOS (and others): Always convert to short UUID
    
    // If it's a 4-char UUID already, return it
    if (cleaned.length === 4) return cleaned;
    
    // If it's a full UUID (32 chars), extract the short UUID part
    if (cleaned.length === 32) {
      // Extract characters 4-8 (the short UUID portion)
      return cleaned.substring(4, 8);
    }
    
    // For other lengths, try to extract something sensible
    // Take the last 4 chars, or pad if too short
    return cleaned.padStart(4, '0').slice(-4);
  }
}


/**
 * Clean timeout wrapper that handles both rejection and cleanup
 * Useful for operations that need timeout with cleanup side effects
 */
export async function withTimeout<T>(
  promise: Promise<T>, 
  timeoutMs: number, 
  onTimeout?: () => void | Promise<void>
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(async () => {
        // Do cleanup FIRST, then reject
        if (onTimeout) {
          try {
            await onTimeout();
          } catch (error) {
            console.error('Timeout cleanup error:', error);
          }
        }
        
        // Now reject after cleanup is complete
        reject(new Error('Operation timeout'));
      }, timeoutMs);
    })
  ]);
}