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
    this.connectionState = {
      ...this.connectionState,
      ...state,
      connectedAt: state.connected ? new Date().toISOString() : 
                   state.connected === false ? null : 
                   this.connectionState.connectedAt
    };
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