import { LogLevel, normalizeLogLevel } from './utils.js';

export class Logger {
  private readonly prefix: string;
  private readonly level: LogLevel;
  private readonly includeTimestamp: boolean;

  constructor(prefix: string) {
    this.prefix = prefix;
    this.level = normalizeLogLevel(process.env.BLE_MCP_LOG_LEVEL);
    this.includeTimestamp = process.env.BLE_MCP_LOG_TIMESTAMPS !== 'false';
  }

  private formatMessage(...args: any[]): any[] {
    if (this.includeTimestamp) {
      const timestamp = new Date().toISOString().substring(11, 23); // HH:MM:SS.mmm
      return [`[${timestamp}] [${this.prefix}]`, ...args];
    }
    return [`[${this.prefix}]`, ...args];
  }

  private shouldLog(messageLevel: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentLevelIndex = levels.indexOf(this.level);
    const messageLevelIndex = levels.indexOf(messageLevel);
    return messageLevelIndex >= currentLevelIndex;
  }

  debug(...args: any[]): void {
    if (this.shouldLog('debug')) {
      console.log(...this.formatMessage(...args));
    }
  }

  info(...args: any[]): void {
    if (this.shouldLog('info')) {
      console.log(...this.formatMessage(...args));
    }
  }

  warn(...args: any[]): void {
    if (this.shouldLog('warn')) {
      console.warn(...this.formatMessage(...args));
    }
  }

  error(...args: any[]): void {
    if (this.shouldLog('error')) {
      console.error(...this.formatMessage(...args));
    }
  }
}