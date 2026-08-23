/**
 * Unit tests for MockBluetooth Testing API
 * Tests the new built-in testing API that replaces eval-based test helpers
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockBluetooth, injectWebBluetoothMock } from '../../src/mock-bluetooth.js';

describe('MockBluetooth Testing API', () => {
  let mockCharacteristic: any;
  let testDevice: any;
  let mockBluetooth: MockBluetooth;
  
  beforeEach(() => {
    // Mock characteristic setup
    mockCharacteristic = {
      writeValue: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      triggerNotification: vi.fn() // Mock the internal triggerNotification method
    };
    
    testDevice = { gatt: { connected: true } };
    
    // Create MockBluetooth instance
    mockBluetooth = new MockBluetooth('ws://localhost:8080', {
      sessionId: 'test',
      service: '1234',
      timeout: 5000,
      onMultipleDevices: 'error'
    });
  });

  describe('Testing API Availability', () => {
    it('should expose testing API after injection', () => {
      // Mock DOM environment
      const mockWindow = {
        navigator: {},
        location: { origin: 'http://localhost' }
      };
      Object.defineProperty(global, 'window', {
        value: mockWindow,
        writable: true
      });
      
      injectWebBluetoothMock({
        sessionId: 'test',
        serverUrl: 'ws://localhost:8080',
        service: '1234'
      });
      
      expect((mockWindow.navigator as any).bluetooth.testing).toBeDefined();
      expect(typeof (mockWindow.navigator as any).bluetooth.testing.testCommand).toBe('function');
      expect(typeof (mockWindow.navigator as any).bluetooth.testing.simulateNotification).toBe('function');
      expect(typeof (mockWindow.navigator as any).bluetooth.testing.utils).toBe('object');
    });
  });

  describe('testCommand', () => {
    it('should handle successful test command', async () => {
      // Setup mock response
      const responseData = new Uint8Array([0xA7, 0xB3, 0x04, 0xD9, 0x82, 0x9E, 0x00, 0x00, 0xA0, 0x01, 0x00]);
      
      // Simulate successful response after a delay
      setTimeout(() => {
        const mockEvent = {
          target: { value: { buffer: responseData.buffer } }
        };
        mockCharacteristic.addEventListener.mock.calls[0][1](mockEvent);
      }, 10);
      
      const result = await mockBluetooth.testing.testCommand({
        device: testDevice,
        writeCharacteristic: mockCharacteristic,
        notifyCharacteristic: mockCharacteristic,
        command: new Uint8Array([0xA7, 0xB3, 0x02]),
        timeout: 100,
        validateResponse: (data) => data.length === 11
      });
      
      expect(result.success).toBe(true);
      expect(result.response).toEqual(responseData);
      expect(result.responseHex).toBe('A7 B3 04 D9 82 9E 00 00 A0 01 00');
      expect(result.timeout).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it('should handle test command timeout', async () => {
      const result = await mockBluetooth.testing.testCommand({
        device: testDevice,
        writeCharacteristic: mockCharacteristic,
        notifyCharacteristic: mockCharacteristic,
        command: new Uint8Array([0xA7, 0xB3, 0x02]),
        timeout: 50  // Short timeout
      });
      
      expect(result.success).toBe(false);
      expect(result.timeout).toBe(true);
      expect(result.error).toBe('Command timeout');
      expect(result.response).toBeUndefined();
    });

    it('should handle writeValue failure', async () => {
      mockCharacteristic.writeValue.mockRejectedValue(new Error('Write failed'));
      
      const result = await mockBluetooth.testing.testCommand({
        device: testDevice,
        writeCharacteristic: mockCharacteristic,
        notifyCharacteristic: mockCharacteristic,
        command: new Uint8Array([0xA7, 0xB3, 0x02])
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Write failed');
      expect(result.timeout).toBeUndefined();
    });

    it('should handle custom validation failure', async () => {
      const responseData = new Uint8Array([0xA7, 0xB3, 0x04]);
      
      setTimeout(() => {
        const mockEvent = {
          target: { value: { buffer: responseData.buffer } }
        };
        mockCharacteristic.addEventListener.mock.calls[0][1](mockEvent);
      }, 10);
      
      const result = await mockBluetooth.testing.testCommand({
        device: testDevice,
        writeCharacteristic: mockCharacteristic,
        notifyCharacteristic: mockCharacteristic,
        command: new Uint8Array([0xA7, 0xB3, 0x02]),
        timeout: 100,
        validateResponse: (data) => data.length > 10 // Will fail
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid response format');
      expect(result.response).toEqual(responseData);
    });

    it('should throw error for missing required options', async () => {
      await expect(mockBluetooth.testing.testCommand({
        device: null as any,
        writeCharacteristic: mockCharacteristic,
        notifyCharacteristic: mockCharacteristic,
        command: new Uint8Array([0xA7])
      })).rejects.toThrow('Missing required options');
    });
  });

  describe('simulateNotification', () => {
    it('should simulate notification successfully', async () => {
      const testData = new Uint8Array([0xA7, 0xB3, 0x01, 0xFF]);
      
      await mockBluetooth.testing.simulateNotification({
        characteristic: mockCharacteristic,
        data: testData
      });
      
      expect(mockCharacteristic.triggerNotification).toHaveBeenCalledWith(testData);
    });

    it('should handle delay in simulation', async () => {
      const testData = new Uint8Array([0xA7, 0xB3, 0x01, 0x00]);
      const startTime = Date.now();
      
      await mockBluetooth.testing.simulateNotification({
        characteristic: mockCharacteristic,
        data: testData,
        delay: 50
      });
      
      const elapsedTime = Date.now() - startTime;
      expect(elapsedTime).toBeGreaterThanOrEqual(45); // Allow some tolerance
      expect(mockCharacteristic.triggerNotification).toHaveBeenCalledWith(testData);
    });

    it('should throw error if characteristic does not support simulation', async () => {
      const badChar = {}; // No triggerNotification or simulateNotification methods
      
      await expect(mockBluetooth.testing.simulateNotification({
        characteristic: badChar as any,
        data: new Uint8Array([0x01, 0x02])
      })).rejects.toThrow('Unable to simulate notification');
    });

    it('should prefer dispatchEvent, which is what the real characteristic exposes', async () => {
      // MockBluetoothRemoteGATTCharacteristic.triggerNotification is PRIVATE;
      // dispatchEvent is its public surface and the standard Web Bluetooth path.
      // The stubs above only have triggerNotification, so without this test the
      // production path would have no coverage at all.
      let dispatched: any = null;
      const realShapedChar = {
        uuid: '2a01',
        dispatchEvent: vi.fn((event: any) => { dispatched = event; return true; }),
        triggerNotification: vi.fn()
      };

      await mockBluetooth.testing.simulateNotification({
        characteristic: realShapedChar as any,
        data: new Uint8Array([0xA7, 0xB3, 0x04])
      });

      expect(realShapedChar.dispatchEvent).toHaveBeenCalled();
      expect(realShapedChar.triggerNotification).not.toHaveBeenCalled();

      // The real class reads target.value as a DataView and converts it back to
      // a Uint8Array via buffer/byteOffset/byteLength — assert that exact shape.
      const view = dispatched.target.value as DataView;
      expect(Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)))
        .toEqual([0xA7, 0xB3, 0x04]);
    });

    it('should preserve the byte range when data is a view into a larger buffer', async () => {
      // `new DataView(data.buffer)` ignores byteOffset/byteLength and hands the
      // app the whole backing buffer. Firehose payloads are subarrays.
      let dispatched: any = null;
      const char = {
        uuid: '2a01',
        dispatchEvent: vi.fn((event: any) => { dispatched = event; return true; })
      };

      const backing = new Uint8Array([0xFF, 0xFF, 0x01, 0x02, 0x03, 0xFF]);
      await mockBluetooth.testing.simulateNotification({
        characteristic: char as any,
        data: backing.subarray(2, 5)
      });

      const view = dispatched.target.value as DataView;
      expect(Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)))
        .toEqual([0x01, 0x02, 0x03]);
    });

    it('should work with legacy simulateNotification method', async () => {
      const legacyChar = {
        simulateNotification: vi.fn()
      };
      const testData = new Uint8Array([0xA7, 0xB3, 0x01, 0xFF]);
      
      await mockBluetooth.testing.simulateNotification({
        characteristic: legacyChar as any,
        data: testData
      });
      
      expect(legacyChar.simulateNotification).toHaveBeenCalledWith(testData);
    });
  });

  describe('utils', () => {
    describe('toHex', () => {
      it('should convert bytes to hex correctly', () => {
        const bytes = new Uint8Array([0xA7, 0xB3, 0x02]);
        const hex = mockBluetooth.testing.utils.toHex(bytes);
        expect(hex).toBe('A7 B3 02');
      });

      it('should handle empty array', () => {
        const bytes = new Uint8Array([]);
        const hex = mockBluetooth.testing.utils.toHex(bytes);
        expect(hex).toBe('');
      });

      it('should handle single byte', () => {
        const bytes = new Uint8Array([0x0F]);
        const hex = mockBluetooth.testing.utils.toHex(bytes);
        expect(hex).toBe('0F');
      });
    });

    describe('fromHex', () => {
      it('should parse spaced hex string', () => {
        const bytes = mockBluetooth.testing.utils.fromHex('A7 B3 02');
        const expected = new Uint8Array([0xA7, 0xB3, 0x02]);
        expect(bytes).toEqual(expected);
      });

      it('should parse continuous hex string', () => {
        const bytes = mockBluetooth.testing.utils.fromHex('A7B302');
        const expected = new Uint8Array([0xA7, 0xB3, 0x02]);
        expect(bytes).toEqual(expected);
      });

      it('should handle mixed spacing', () => {
        const bytes = mockBluetooth.testing.utils.fromHex('A7  B3   02');
        const expected = new Uint8Array([0xA7, 0xB3, 0x02]);
        expect(bytes).toEqual(expected);
      });

      it('should handle lowercase hex', () => {
        const bytes = mockBluetooth.testing.utils.fromHex('a7 b3 02');
        const expected = new Uint8Array([0xA7, 0xB3, 0x02]);
        expect(bytes).toEqual(expected);
      });

      it('should handle empty string', () => {
        const bytes = mockBluetooth.testing.utils.fromHex('');
        const expected = new Uint8Array([]);
        expect(bytes).toEqual(expected);
      });
    });

    describe('equals', () => {
      it('should return true for equal arrays', () => {
        const a = new Uint8Array([0xA7, 0xB3, 0x02]);
        const b = new Uint8Array([0xA7, 0xB3, 0x02]);
        expect(mockBluetooth.testing.utils.equals(a, b)).toBe(true);
      });

      it('should return false for different arrays', () => {
        const a = new Uint8Array([0xA7, 0xB3, 0x02]);
        const b = new Uint8Array([0xA7, 0xB3, 0x03]);
        expect(mockBluetooth.testing.utils.equals(a, b)).toBe(false);
      });

      it('should return false for different length arrays', () => {
        const a = new Uint8Array([0xA7, 0xB3]);
        const b = new Uint8Array([0xA7, 0xB3, 0x02]);
        expect(mockBluetooth.testing.utils.equals(a, b)).toBe(false);
      });

      it('should return true for empty arrays', () => {
        const a = new Uint8Array([]);
        const b = new Uint8Array([]);
        expect(mockBluetooth.testing.utils.equals(a, b)).toBe(true);
      });
    });
  });

  describe('Integration', () => {
    it('should provide round-trip hex conversion', () => {
      const original = new Uint8Array([0xA7, 0xB3, 0x02, 0xD9, 0x82]);
      const hex = mockBluetooth.testing.utils.toHex(original);
      const restored = mockBluetooth.testing.utils.fromHex(hex);
      
      expect(mockBluetooth.testing.utils.equals(original, restored)).toBe(true);
    });

    it('should work with testCommand and utils together', async () => {
      const commandHex = 'A7 B3 02 D9 82 37 00 00 A0 01';
      const responseHex = 'A7 B3 04 D9 82 9E 00 00 A0 01 00';
      
      const commandBytes = mockBluetooth.testing.utils.fromHex(commandHex);
      const responseBytes = mockBluetooth.testing.utils.fromHex(responseHex);
      
      // Simulate successful response
      setTimeout(() => {
        const mockEvent = {
          target: { value: { buffer: responseBytes.buffer } }
        };
        mockCharacteristic.addEventListener.mock.calls[0][1](mockEvent);
      }, 10);
      
      const result = await mockBluetooth.testing.testCommand({
        device: testDevice,
        writeCharacteristic: mockCharacteristic,
        notifyCharacteristic: mockCharacteristic,
        command: commandBytes,
        timeout: 100,
        validateResponse: (data) => {
          // Validate trigger status response
          return data.length === 11 && 
                 data[8] === 0xA0 && 
                 data[9] === 0x01 && 
                 data[10] === 0x00;
        }
      });
      
      expect(result.success).toBe(true);
      expect(result.responseHex).toBe(responseHex);
      expect(mockBluetooth.testing.utils.equals(result.response!, responseBytes)).toBe(true);
    });
  });
});