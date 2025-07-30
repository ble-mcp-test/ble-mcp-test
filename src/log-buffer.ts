import { formatHex } from './utils.js';
import { Logger } from './logger.js';

export interface LogEntry {
  id: number;              // Global sequence number
  timestamp: string;       // ISO timestamp
  direction: 'TX' | 'RX';  // Packet direction
  hex: string;             // Raw hex data (uppercase, space-separated)
  size: number;            // Byte count
}

export class LogBuffer {
  private buffer: LogEntry[] = [];
  private maxSize: number;
  private logger: Logger;
  private sequenceCounter = 0;
  private clientPositions = new Map<string, number>(); // client_id -> last_seen_id
  private subscribers: Array<(entry: LogEntry) => void> = [];

  constructor(maxSize?: number) {
    // Default 10k, configurable via env var or constructor
    this.maxSize = maxSize || parseInt(process.env.BLE_MCP_LOG_BUFFER_SIZE || '10000', 10);
    this.logger = new Logger('LogBuffer');
    
    // Validate reasonable bounds (100 to 1M entries)
    if (this.maxSize < 100) this.maxSize = 100;
    if (this.maxSize > 1000000) this.maxSize = 1000000;
    
    this.logger.debug(`Initialized with max size: ${this.maxSize} entries`);
  }

  push(direction: 'TX' | 'RX', data: Uint8Array): void {
    const entry: LogEntry = {
      id: this.sequenceCounter++,
      timestamp: new Date().toISOString(),
      direction,
      hex: formatHex(data),
      size: data.length
    };

    this.buffer.push(entry);

    // Maintain circular buffer size
    while (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }

    // Notify subscribers
    this.subscribers.forEach(callback => callback(entry));
  }

  // Alias for compatibility
  logPacket(direction: 'TX' | 'RX', data: Uint8Array): void {
    this.push(direction, data);
  }

  pushSystemLog(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
    const entry: LogEntry = {
      id: this.sequenceCounter++,
      timestamp: new Date().toISOString(),
      direction: level as any, // Reuse direction field for log level
      hex: message, // Store message in hex field
      size: 0
    };

    this.buffer.push(entry);

    // Maintain circular buffer size
    while (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  getLogsSince(since: string, limit: number, clientId?: string): LogEntry[] {
    const startIdx = this.parseSince(since, clientId);
    
    // Filter from start index
    const filtered = this.buffer.slice(startIdx);
    
    // Apply limit
    const result = filtered.slice(0, limit);
    
    // Update client position if clientId provided
    if (clientId && result.length > 0) {
      const lastId = result[result.length - 1].id;
      this.updateClientPosition(clientId, lastId);
    }
    
    return result;
  }

  searchPackets(hexPattern: string, limit: number): LogEntry[] {
    // Convert hex pattern to regex-safe string (remove spaces)
    const cleanPattern = hexPattern.replace(/\s+/g, '').toUpperCase();
    
    // Create regex that matches the pattern in the hex string
    const regex = new RegExp(cleanPattern, 'i');
    
    const matches: LogEntry[] = [];
    
    // Search from newest to oldest
    for (let i = this.buffer.length - 1; i >= 0 && matches.length < limit; i--) {
      const entry = this.buffer[i];
      const cleanHex = entry.hex.replace(/\s+/g, '');
      
      if (regex.test(cleanHex)) {
        matches.push(entry);
      }
    }
    
    // Return in chronological order
    return matches.reverse();
  }

  getClientPosition(clientId: string): number {
    return this.clientPositions.get(clientId) || 0;
  }

  updateClientPosition(clientId: string, lastSeenId: number): void {
    this.clientPositions.set(clientId, lastSeenId);
  }

  private parseSince(since: string, clientId?: string): number {
    // Handle 'last' - return client's last position
    if (since === 'last' && clientId) {
      const lastId = this.clientPositions.get(clientId) || 0;
      return this.buffer.findIndex(e => e.id > lastId);
    }
    
    // Handle duration strings: '30s', '5m', '1h'
    const durationMatch = since.match(/^(\d+)([smh])$/);
    if (durationMatch) {
      const [, num, unit] = durationMatch;
      const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000 };
      const cutoffTime = Date.now() - (parseInt(num) * multipliers[unit]);
      
      // Find first entry after cutoff
      const idx = this.buffer.findIndex(e => new Date(e.timestamp).getTime() > cutoffTime);
      return idx === -1 ? 0 : idx;
    }
    
    // Handle ISO timestamp
    try {
      const cutoffTime = new Date(since).getTime();
      const idx = this.buffer.findIndex(e => new Date(e.timestamp).getTime() > cutoffTime);
      return idx === -1 ? 0 : idx;
    } catch {
      // Default to beginning if parsing fails
      return 0;
    }
  }

  // Helper method for testing and debugging
  getBufferSize(): number {
    return this.buffer.length;
  }

  // Helper method to get current connection state
  getConnectionStats(): { packetsTransmitted: number; packetsReceived: number } {
    let packetsTransmitted = 0;
    let packetsReceived = 0;
    
    for (const entry of this.buffer) {
      if (entry.direction === 'TX') {
        packetsTransmitted++;
      } else {
        packetsReceived++;
      }
    }
    
    return { packetsTransmitted, packetsReceived };
  }

  // Subscribe to new entries
  subscribe(callback: (entry: LogEntry) => void): () => void {
    this.subscribers.push(callback);
    
    // Return unsubscribe function
    return () => {
      const index = this.subscribers.indexOf(callback);
      if (index > -1) {
        this.subscribers.splice(index, 1);
      }
    };
  }
}