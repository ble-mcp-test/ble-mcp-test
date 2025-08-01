import { LogBuffer } from './log-buffer.js';

/**
 * Shared state between bridge and observability services
 * 
 * This provides a clean interface for:
 * - Bridge to write packet logs and connection state
 * - Observability to read logs and state without coupling
 */
export class SharedState {
  private logBuffer: LogBuffer;
  private connectionState = {
    connected: false,
    deviceName: null as string | null,
    recovering: false,
    connectedAt: null as string | null
  };
  private originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error
  };

  constructor(interceptConsole = true) {
    this.logBuffer = new LogBuffer();
    
    if (interceptConsole) {
      this.setupConsoleInterceptor();
    }
  }

  private setupConsoleInterceptor(): void {
    // Intercept console methods to capture bridge logs
    console.log = (...args) => {
      this.originalConsole.log.apply(console, args);
      const message = args.join(' ');
      if (message.includes('[Bridge]')) {
        this.logBuffer.pushSystemLog('INFO', message);
      }
    };
    
    console.warn = (...args) => {
      this.originalConsole.warn.apply(console, args);
      const message = args.join(' ');
      this.logBuffer.pushSystemLog('WARN', message);
    };
    
    console.error = (...args) => {
      this.originalConsole.error.apply(console, args);
      const message = args.join(' ');
      this.logBuffer.pushSystemLog('ERROR', message);
    };
  }

  // === Write Interface (for Bridge) ===
  
  logPacket(direction: 'TX' | 'RX', data: Uint8Array): void {
    this.logBuffer.logPacket(direction, data);
  }

  setConnectionState(state: Partial<{ 
    connected: boolean; 
    deviceName: string | null; 
    recovering: boolean 
  }>): void {
    const before = { ...this.connectionState };
    this.connectionState = {
      ...this.connectionState,
      ...state,
      connectedAt: state.connected ? new Date().toISOString() : 
                   state.connected === false ? null : 
                   this.connectionState.connectedAt
    };
    // Force this log to appear in the main console (not intercepted)
    const originalLog = this.originalConsole.log;
    originalLog(`[SharedState] 📊 State updated: ${JSON.stringify(before)} → ${JSON.stringify(this.connectionState)}`);
    
    // Also log to the buffer directly
    this.logBuffer.pushSystemLog('INFO', `[SharedState] 📊 State updated: ${JSON.stringify(before)} → ${JSON.stringify(this.connectionState)}`);
    
    // File-based logging fallback
    try {
      // Dynamic import for Node.js fs module
      import('fs').then(fs => {
        const timestamp = new Date().toISOString();
        const logEntry = `${timestamp} [SharedState] 📊 State updated: ${JSON.stringify(before)} → ${JSON.stringify(this.connectionState)}\n`;
        fs.appendFileSync('/tmp/ble-state.log', logEntry);
      });
    } catch {
      // Ignore file logging errors
    }
  }

  // === Read Interface (for Observability) ===

  getLogBuffer(): LogBuffer {
    return this.logBuffer;
  }

  getConnectionState() {
    return { ...this.connectionState };
  }

  getConnectionStats() {
    return this.logBuffer.getConnectionStats();
  }

  // Restore original console methods
  restoreConsole(): void {
    console.log = this.originalConsole.log;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
  }
}