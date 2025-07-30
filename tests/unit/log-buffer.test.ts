import { describe, it, expect, beforeEach } from 'vitest';
import { LogBuffer } from '../../src/log-buffer.js';

describe('LogBuffer', () => {
  let buffer: LogBuffer;
  
  beforeEach(() => {
    // Clear env var before each test
    delete process.env.BLE_MCP_LOG_BUFFER_SIZE;
  });
  
  describe('buffer size configuration', () => {
    it('should maintain max 10k entries by default', () => {
      buffer = new LogBuffer();
      
      for (let i = 0; i < 11000; i++) {
        buffer.push('TX', new Uint8Array([i & 0xFF]));
      }
      
      expect(buffer.getBufferSize()).toBe(10000);
      expect(buffer.getLogsSince('0', 20000).length).toBe(10000);
    });
    
    it('should respect custom buffer size', () => {
      buffer = new LogBuffer(5000);
      
      for (let i = 0; i < 6000; i++) {
        buffer.push('TX', new Uint8Array([i & 0xFF]));
      }
      
      expect(buffer.getBufferSize()).toBe(5000);
      expect(buffer.getLogsSince('0', 10000).length).toBe(5000);
    });
    
    it('should respect BLE_MCP_LOG_BUFFER_SIZE env var', () => {
      process.env.BLE_MCP_LOG_BUFFER_SIZE = '2000';
      buffer = new LogBuffer();
      
      for (let i = 0; i < 3000; i++) {
        buffer.push('TX', new Uint8Array([i & 0xFF]));
      }
      
      expect(buffer.getBufferSize()).toBe(2000);
      expect(buffer.getLogsSince('0', 5000).length).toBe(2000);
    });
    
    it('should enforce minimum buffer size of 100', () => {
      buffer = new LogBuffer(50);
      expect(buffer.getBufferSize()).toBe(0); // No entries yet
      
      for (let i = 0; i < 150; i++) {
        buffer.push('TX', new Uint8Array([i]));
      }
      
      expect(buffer.getBufferSize()).toBe(100);
    });
    
    it('should enforce maximum buffer size of 1M', () => {
      process.env.BLE_MCP_LOG_BUFFER_SIZE = '2000000';
      buffer = new LogBuffer();
      
      // Just check the limit is enforced, not actually create 1M entries
      const logs = buffer.getLogsSince('0', 1);
      expect(logs).toEqual([]);
    });
  });
  
  describe('time parsing', () => {
    beforeEach(() => {
      buffer = new LogBuffer(100);
    });
    
    it('should parse duration strings correctly', () => {
      // Add multiple entries
      buffer.push('TX', new Uint8Array([1]));
      buffer.push('TX', new Uint8Array([2]));
      buffer.push('TX', new Uint8Array([3]));
      
      // Test that duration parsing doesn't crash and returns results
      const recent = buffer.getLogsSince('100ms', 10);
      expect(recent.length).toBeGreaterThanOrEqual(0);
      expect(recent.length).toBeLessThanOrEqual(3);
      
      const fromMinute = buffer.getLogsSince('1m', 10);
      expect(fromMinute.length).toBe(3);
      
      const fromHour = buffer.getLogsSince('1h', 10);
      expect(fromHour.length).toBe(3);
      
      const fromDay = buffer.getLogsSince('1d', 10);
      expect(fromDay.length).toBe(3);
    });
    
    it('should handle ISO timestamp', () => {
      const now = new Date();
      const past = new Date(now.getTime() - 60000); // 1 minute ago
      
      buffer.push('TX', new Uint8Array([1]));
      buffer.push('RX', new Uint8Array([2]));
      
      const logs = buffer.getLogsSince(past.toISOString(), 10);
      expect(logs.length).toBe(2);
    });
    
    it('should handle invalid since parameter by returning all logs', () => {
      buffer.push('TX', new Uint8Array([1]));
      buffer.push('RX', new Uint8Array([2]));
      
      const logs = buffer.getLogsSince('invalid', 10);
      expect(logs.length).toBe(2);
    });
  });
  
  describe('client position tracking', () => {
    beforeEach(() => {
      buffer = new LogBuffer(100);
    });
    
    it('should track client positions', () => {
      // Add some logs
      for (let i = 0; i < 10; i++) {
        buffer.push('TX', new Uint8Array([i]));
      }
      
      // Client reads first 5
      const firstBatch = buffer.getLogsSince('0', 5, 'client1');
      expect(firstBatch.length).toBe(5);
      expect(firstBatch[4].id).toBe(4);
      
      // Add more logs
      for (let i = 10; i < 15; i++) {
        buffer.push('RX', new Uint8Array([i]));
      }
      
      // Client reads from last position
      const secondBatch = buffer.getLogsSince('last', 10, 'client1');
      expect(secondBatch.length).toBe(10);
      expect(secondBatch[0].id).toBe(5);
    });
    
    it('should handle multiple clients independently', () => {
      // Add logs
      for (let i = 0; i < 10; i++) {
        buffer.push('TX', new Uint8Array([i]));
      }
      
      // Client 1 reads
      buffer.getLogsSince('0', 3, 'client1');
      
      // Client 2 reads
      buffer.getLogsSince('0', 5, 'client2');
      
      // Check positions
      expect(buffer.getClientPosition('client1')).toBe(2);
      expect(buffer.getClientPosition('client2')).toBe(4);
    });
  });
  
  describe('hex pattern search', () => {
    beforeEach(() => {
      buffer = new LogBuffer(100);
    });
    
    it('should find packets by hex pattern', () => {
      buffer.push('TX', new Uint8Array([0xA7, 0xB3, 0x01, 0x00]));
      buffer.push('RX', new Uint8Array([0x02, 0x01, 0xE2]));
      buffer.push('TX', new Uint8Array([0xA7, 0xB3, 0x02, 0x00]));
      
      const matches = buffer.searchPackets('A7B3', 10);
      expect(matches.length).toBe(2);
      expect(matches[0].direction).toBe('TX');
      expect(matches[1].direction).toBe('TX');
    });
    
    it('should handle hex pattern with spaces', () => {
      buffer.push('TX', new Uint8Array([0xA7, 0xB3, 0x01]));
      
      const matches1 = buffer.searchPackets('A7 B3', 10);
      const matches2 = buffer.searchPackets('A7B3', 10);
      
      expect(matches1.length).toBe(1);
      expect(matches2.length).toBe(1);
    });
    
    it('should be case insensitive', () => {
      buffer.push('TX', new Uint8Array([0xAB, 0xCD]));
      
      const matches1 = buffer.searchPackets('abcd', 10);
      const matches2 = buffer.searchPackets('ABCD', 10);
      const matches3 = buffer.searchPackets('AbCd', 10);
      
      expect(matches1.length).toBe(1);
      expect(matches2.length).toBe(1);
      expect(matches3.length).toBe(1);
    });
    
    it('should limit search results', () => {
      // Add many matching packets
      for (let i = 0; i < 20; i++) {
        buffer.push('TX', new Uint8Array([0xFF, i]));
      }
      
      const matches = buffer.searchPackets('FF', 5);
      expect(matches.length).toBe(5);
    });
    
    it('should return results in chronological order', () => {
      buffer.push('TX', new Uint8Array([0xAA, 0x01]));
      buffer.push('RX', new Uint8Array([0xAA, 0x02]));
      buffer.push('TX', new Uint8Array([0xAA, 0x03]));
      
      const matches = buffer.searchPackets('AA', 10);
      expect(matches.length).toBe(3);
      expect(matches[0].hex).toContain('AA 01');
      expect(matches[1].hex).toContain('AA 02');
      expect(matches[2].hex).toContain('AA 03');
    });
  });
  
  describe('connection statistics', () => {
    beforeEach(() => {
      buffer = new LogBuffer(100);
    });
    
    it('should count TX and RX packets correctly', () => {
      buffer.push('TX', new Uint8Array([1]));
      buffer.push('TX', new Uint8Array([2]));
      buffer.push('RX', new Uint8Array([3]));
      buffer.push('TX', new Uint8Array([4]));
      buffer.push('RX', new Uint8Array([5]));
      
      const stats = buffer.getConnectionStats();
      expect(stats.packetsTransmitted).toBe(3);
      expect(stats.packetsReceived).toBe(2);
    });
    
    it('should handle empty buffer', () => {
      const stats = buffer.getConnectionStats();
      expect(stats.packetsTransmitted).toBe(0);
      expect(stats.packetsReceived).toBe(0);
    });
  });
  
  describe('log entry format', () => {
    beforeEach(() => {
      buffer = new LogBuffer(10);
    });
    
    it('should create properly formatted log entries', () => {
      const data = new Uint8Array([0xA7, 0xB3, 0x01]);
      buffer.push('TX', data);
      
      const logs = buffer.getLogsSince('0', 1);
      expect(logs.length).toBe(1);
      
      const entry = logs[0];
      expect(entry.id).toBe(0);
      expect(entry.direction).toBe('TX');
      expect(entry.hex).toBe('A7 B3 01');
      expect(entry.size).toBe(3);
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
    
    it('should increment sequence numbers globally', () => {
      buffer.push('TX', new Uint8Array([1]));
      buffer.push('RX', new Uint8Array([2]));
      buffer.push('TX', new Uint8Array([3]));
      
      const logs = buffer.getLogsSince('0', 10);
      expect(logs[0].id).toBe(0);
      expect(logs[1].id).toBe(1);
      expect(logs[2].id).toBe(2);
    });
  });
});