import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { BridgeServer } from '../../src/bridge-server.js';
import { formatHex, normalizeLogLevel } from '../../src/utils.js';
import { WS_URL, getDeviceConfig } from '../test-config.js';
import { connectionFactory } from '../connection-factory.js';

const DEVICE_CONFIG = getDeviceConfig();

describe('Logging Functionality Tests', () => {
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
  
  describe('Server logging at different levels', () => {
    it('shows TX/RX hex logs at debug level', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => {
        logs.push(args.join(' '));
        originalLog(...args);
      };
      
      const server = new BridgeServer('debug');
      await server.start(0); // Use random port
      
      // Connect and send data
      const params = new URLSearchParams(DEVICE_CONFIG);
      const connectionResult = await connectionFactory.connect(WS_URL, params);
      
      if (connectionResult.connected) {
        // Send test data
        const testData = [0xA7, 0xB3, 0xC2, 0x01, 0x00];
        await connectionFactory.sendCommand({ type: 'data', data: testData });
        
        // Wait for logs
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Check for TX log
        const txLogs = logs.filter(log => log.includes('[TX]'));
        expect(txLogs.length).toBeGreaterThan(0);
        expect(txLogs[0]).toContain('A7 B3 C2 01 00');
      }
      
      console.log = originalLog;
      await server.stop();
    });
    
    it('hides TX/RX hex logs at info level', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => {
        logs.push(args.join(' '));
        originalLog(...args);
      };
      
      const server = new BridgeServer('info');
      await server.start(0); // Use random port
      
      // Connect and send data
      const params = new URLSearchParams(DEVICE_CONFIG);
      const connectionResult = await connectionFactory.connect(WS_URL, params);
      
      if (connectionResult.connected) {
        // Send test data
        const testData = [0xA7, 0xB3, 0xC2, 0x01, 0x00];
        await connectionFactory.sendCommand({ type: 'data', data: testData });
        
        // Wait for logs
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Check that no TX/RX logs appear
        const txRxLogs = logs.filter(log => log.includes('[TX]') || log.includes('[RX]'));
        expect(txRxLogs.length).toBe(0);
        
        // But server startup logs should still appear
        const startupLogs = logs.filter(log => log.includes('Starting WebSocket') || log.includes('BridgeServer'));
        expect(startupLogs.length).toBeGreaterThan(0);
      }
      
      console.log = originalLog;
      await server.stop();
    });
    
    it('hides discovery logs at info level', async () => {
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => {
        logs.push(args.join(' '));
        originalLog(...args);
      };
      
      const server = new BridgeServer('info');
      await server.start(0); // Use random port
      
      // Try to connect (may fail if no device, but we'll still see scan logs)
      const params = new URLSearchParams(DEVICE_CONFIG);
      await connectionFactory.connect(WS_URL, params);
      
      // Wait for potential discovery logs
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check that no discovery logs appear
      const discoveryLogs = logs.filter(log => log.includes('[NobleTransport] Discovered:'));
      expect(discoveryLogs.length).toBe(0);
      
      // But scanning started logs should still appear
      const scanLogs = logs.filter(log => log.includes('Scanning started') || log.includes('Starting scan'));
      expect(scanLogs.length).toBeGreaterThan(0);
      
      console.log = originalLog;
      await server.stop();
    });
  });
});