import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import WebSocket from 'ws';
import { formatHex, normalizeLogLevel } from '../../src/utils.js';
import { setupTestServer, WS_URL, getDeviceConfig } from '../test-config.js';
import { connectionFactory } from '../connection-factory.js';

const DEVICE_CONFIG = getDeviceConfig();

// CS108 GET_BATTERY_VOLTAGE command for testing
// TODO: Standardize to nRF52 test commands in the future
const CS108_BATTERY_COMMAND = {
  type: 'data',
  data: [0xA7, 0xB3, 0xC2, 0x01, 0x00, 0x00, 0xA0, 0x00, 0xB3, 0xA7]
};

describe('Logging Functionality Tests', () => {
  let server: any = null;
  
  beforeAll(async () => {
    // Set LOG_LEVEL for test
    process.env.LOG_LEVEL = 'debug';
    server = await setupTestServer();
  });
  
  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });
  
  describe('Utils functions', () => {
    it('formats hex correctly', () => {
      const data = new Uint8Array([0xA7, 0xB3, 0xC2, 0x01, 0x00]);
      expect(formatHex(data)).toBe('A7 B3 C2 01 00');
      
      const buffer = Buffer.from([0x12, 0x34, 0x56, 0x78]);
      expect(formatHex(buffer)).toBe('12 34 56 78');
      
      const empty = new Uint8Array([]);
      expect(formatHex(empty)).toBe('');
    });
    
    it('normalizes log levels correctly', () => {
      expect(normalizeLogLevel('debug')).toBe('debug');
      expect(normalizeLogLevel('info')).toBe('info');
      expect(normalizeLogLevel('error')).toBe('error');
      
      // Test aliases
      expect(normalizeLogLevel('verbose')).toBe('debug');
      expect(normalizeLogLevel('trace')).toBe('debug');
      expect(normalizeLogLevel('warn')).toBe('info');
      expect(normalizeLogLevel('warning')).toBe('info');
      
      // Test undefined/default
      expect(normalizeLogLevel(undefined)).toBe('debug');
      expect(normalizeLogLevel('')).toBe('debug');
      
      // Test unknown with warning
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(normalizeLogLevel('invalid')).toBe('debug');
      expect(warnSpy).toHaveBeenCalledWith("[Config] Unknown log level 'invalid', defaulting to debug");
      warnSpy.mockRestore();
    });
  });
  
  describe('Bytestream logging via log-stream WebSocket', () => {
    it('shows TX/RX hex logs at debug level', async () => {
      const logs: any[] = [];
      
      // Connect to log stream
      const logWs = new WebSocket(`${WS_URL}?command=log-stream`);
      
      await new Promise<void>((resolve, reject) => {
        logWs.on('open', () => resolve());
        logWs.on('error', reject);
      });
      
      // Capture log messages
      logWs.on('message', (data) => {
        const log = JSON.parse(data.toString());
        logs.push(log);
      });
      
      // Connect and send CS108 battery command
      const params = new URLSearchParams(DEVICE_CONFIG);
      const connectionResult = await connectionFactory.connect(WS_URL, params);
      
      if (connectionResult.connected) {
        await connectionFactory.sendCommand(CS108_BATTERY_COMMAND);
        
        // Wait for logs to arrive
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Check for TX log with CS108 command hex
        const txLogs = logs.filter(log => 
          log.type === 'log' && 
          log.message.includes('[TX]') && 
          log.message.includes('A7 B3 C2 01 00 00 A0 00 B3 A7')
        );
        expect(txLogs.length).toBeGreaterThan(0);
        
        await connectionFactory.cleanup();
      }
      
      logWs.close();
    });
  });
  
  describe('Server with different log levels', () => {
    it('respects LOG_LEVEL environment variable', async () => {
      // This test verifies that the server was started with the correct log level
      // We can verify this by checking if debug-level logs are present
      
      const logs: any[] = [];
      
      // Connect to log stream
      const logWs = new WebSocket(`${WS_URL}?command=log-stream`);
      
      await new Promise<void>((resolve, reject) => {
        logWs.on('open', () => resolve());
        logWs.on('error', reject);
      });
      
      // Capture log messages
      logWs.on('message', (data) => {
        const log = JSON.parse(data.toString());
        logs.push(log);
      });
      
      // Trigger some activity
      const params = new URLSearchParams(DEVICE_CONFIG);
      const connectionResult = await connectionFactory.connect(WS_URL, params);
      
      if (connectionResult.connected) {
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // At debug level, we should see discovery logs
        const discoveryLogs = logs.filter(log => 
          log.type === 'log' && 
          log.message.includes('[NobleTransport] Discovered:')
        );
        
        // Should have discovery logs since we're at debug level
        expect(discoveryLogs.length).toBeGreaterThan(0);
        
        await connectionFactory.cleanup();
      }
      
      logWs.close();
    });
  });
  
  describe('Environment variable integration', () => {
    it('normalizeLogLevel handles environment variables correctly', () => {
      const originalEnv = process.env.LOG_LEVEL;
      
      // Test with environment variable set
      process.env.LOG_LEVEL = 'info';
      expect(normalizeLogLevel(process.env.LOG_LEVEL)).toBe('info');
      
      process.env.LOG_LEVEL = 'verbose';
      expect(normalizeLogLevel(process.env.LOG_LEVEL)).toBe('debug');
      
      // Clean up
      if (originalEnv !== undefined) {
        process.env.LOG_LEVEL = originalEnv;
      } else {
        delete process.env.LOG_LEVEL;
      }
    });
  });
});