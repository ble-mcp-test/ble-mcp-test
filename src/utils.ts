export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function formatHex(data: Uint8Array | Buffer): string {
  const bytes = data instanceof Buffer ? data : Buffer.from(data);
  return bytes.toString('hex').toUpperCase().match(/.{2}/g)?.join(' ') || '';
}

/**
 * Log error with stack trace showing where it was thrown
 */
export function logErrorWithStack(prefix: string, error: any): void {
  console.error(`${prefix}:`, error.message || error);
  
  if (error.stack) {
    const stackLines = error.stack.split('\n');
    // First line is usually the error message, second line is where it was thrown
    const thrownFrom = stackLines[1]?.trim() || 'unknown location';
    console.error(`${prefix} thrown from: ${thrownFrom}`);
    
    // For debugging, show first few stack frames
    if (process.env.BLE_MCP_LOG_LEVEL === 'debug') {
      console.error(`${prefix} stack trace:`);
      stackLines.slice(0, 5).forEach((line: string) => console.error(`  ${line}`));
    }
  } else if (typeof error === 'object') {
    console.error(`${prefix} details:`, error);
  }
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