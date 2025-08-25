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

export function expandUuidVariants(uuid: string): string[] {
  const clean = uuid.toLowerCase().replace(/-/g, '');
  const variants: string[] = [];
  
  if (clean.length === 4) {
    // Short UUID - add both short and expanded forms (with and without dashes)
    variants.push(clean);                                    // '9800'
    const fullUuid = `0000${clean}00001000800000805f9b34fb`; 
    variants.push(fullUuid);                                 // Full form without dashes
    // Add dashed version for platforms that use them
    variants.push(`${fullUuid.substring(0,8)}-${fullUuid.substring(8,12)}-${fullUuid.substring(12,16)}-${fullUuid.substring(16,20)}-${fullUuid.substring(20)}`);
  } else if (clean.length === 32) {
    // Check if it's a standard Bluetooth UUID (expandable to short)
    if (clean.endsWith('00001000800000805f9b34fb') && clean.startsWith('0000')) {
      const shortUuid = clean.substring(4, 8);
      variants.push(shortUuid);                              // '9800'
    }
    variants.push(clean);                                    // Original full UUID without dashes
    // Add dashed version for platforms that use them
    variants.push(`${clean.substring(0,8)}-${clean.substring(8,12)}-${clean.substring(12,16)}-${clean.substring(16,20)}-${clean.substring(20)}`);
  } else {
    // Custom UUID or other length - use as-is (both with and without dashes if it looks like a UUID)
    variants.push(clean);
    // If it looks like it could be a UUID (reasonable length), add dashed version
    if (clean.length === 16 || clean.length === 24 || clean.length === 28) {
      // Add dashed version for other UUID formats
      if (clean.length === 16) {
        // 16-char format
        variants.push(`${clean.substring(0,8)}-${clean.substring(8)}`);
      } else if (clean.length >= 20) {
        // Try standard UUID dash pattern
        const padded = clean.padEnd(32, '0');
        variants.push(`${padded.substring(0,8)}-${padded.substring(8,12)}-${padded.substring(12,16)}-${padded.substring(16,20)}-${padded.substring(20)}`);
      }
    }
  }
  
  // Remove duplicates and return
  return [...new Set(variants)];
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