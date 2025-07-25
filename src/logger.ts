import { LogLevel, normalizeLogLevel } from './utils.js';

export class Logger {
  private readonly prefix: string;
  private readonly level: LogLevel;

  constructor(prefix: string) {
    this.prefix = prefix;
    this.level = normalizeLogLevel(process.env.LOG_LEVEL);
  }

  private shouldLog(messageLevel: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentLevelIndex = levels.indexOf(this.level);
    const messageLevelIndex = levels.indexOf(messageLevel);
    return messageLevelIndex >= currentLevelIndex;
  }

  debug(...args: any[]): void {
    if (this.shouldLog('debug')) {
      console.log(`[${this.prefix}]`, ...args);
    }
  }

  info(...args: any[]): void {
    if (this.shouldLog('info')) {
      console.log(`[${this.prefix}]`, ...args);
    }
  }

  warn(...args: any[]): void {
    if (this.shouldLog('warn')) {
      console.warn(`[${this.prefix}]`, ...args);
    }
  }

  error(...args: any[]): void {
    if (this.shouldLog('error')) {
      console.error(`[${this.prefix}]`, ...args);
    }
  }
}