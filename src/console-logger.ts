import { LogEntry } from './log-buffer.js';

/**
 * ConsoleLogger - Responsible for formatting and outputting log entries to console
 * Subscribes to LogBuffer to maintain separation of concerns
 */
export class ConsoleLogger {
  
  constructor() {
    // Pure formatting concern - no storage responsibilities
  }

  /**
   * Format and output a log entry to console with millisecond precision
   */
  logEntry(entry: LogEntry): void {
    if (entry.direction === 'TX' || entry.direction === 'RX') {
      // Extract milliseconds from the timestamp for sequencing  
      const ms = new Date(entry.timestamp).getMilliseconds().toString().padStart(3, '0');
      console.log(`[WSHandler] ${entry.direction}.${ms}: ${entry.hex}`);
    } else {
      // System log entries
      console.log(`[${entry.direction}] ${entry.hex}`);
    }
  }
}