/**
 * Unit tests for MockBluetooth Testing API
 * Tests the new built-in testing API that replaces eval-based test helpers
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MockBluetooth,
  MockBluetoothRemoteGATTCharacteristic,
  injectWebBluetoothMock
} from '../../src/mock-bluetooth.js';

/**
 * Build a real MockBluetoothRemoteGATTCharacteristic through the chain
 * production uses: requestDevice -> gatt -> getPrimaryService -> getCharacteristic.
 *
 * Nothing here opens a socket. WebSocketTransport's constructor only stores the
 * URL and onMessage only stores a callback, so the whole chain runs offline --
 * which is what makes a real instance affordable in a unit test.
 */
async function realDevice() {
  const bluetooth = new MockBluetooth('ws://localhost:25153', {
    sessionId: 'test',
    service: '0000f00d-0000-1000-8000-00805f9b34fb',
    timeout: 5000,
    onMultipleDevices: 'error'
  });
  const device = await bluetooth.requestDevice();
  // getPrimaryService guards on this flag. Connecting for real would need a live
  // bridge, and the notification path never touches the transport.
  device.gatt.connected = true;
  return device;
}

async function realCharacteristic(uuid = '0000f00d-0000-1000-8000-00805f9b34fb'): Promise<MockBluetoothRemoteGATTCharacteristic> {
  const device = await realDevice();
  const service = await device.gatt.getPrimaryService('0000f00d-0000-1000-8000-00805f9b34fb');
  const characteristic = await service.getCharacteristic(uuid);
  // TRA-1153 item 2 made the subscription real: nothing is delivered until this
  // is called, on the transport path or through the testing API. Subscribing in
  // the helper keeps these tests about notification DELIVERY rather than about
  // the gate, which mock-lifecycle.test.ts owns.
  await characteristic.startNotifications();
  return characteristic;
}

/** Record every notification a real characteristic delivers, as plain bytes. */
function collectNotifications(characteristic: MockBluetoothRemoteGATTCharacteristic): number[][] {
  const received: number[][] = [];
  characteristic.addEventListener('characteristicvaluechanged', (event: any) => {
    const view = event.target.value;
    received.push(Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)));
  });
  return received;
}

describe('MockBluetooth Testing API', () => {
  let mockCharacteristic: any;
  let testDevice: any;
  let mockBluetooth: MockBluetooth;
  
  beforeEach(() => {
    // Stub characteristic for the testCommand tests, which are about
    // testCommand's own timeout/validation logic rather than about delivery.
    // The notification path is covered against a real instance further down.
    //
    // `isSubscribed` and `uuid` are NOT decoration. This stub modelled neither,
    // and that is exactly why these tests stayed green for the whole period in
    // which testCommand could not work against a real characteristic: the stub
    // had no subscription state to gate on, so the gate TRA-1153 item 2 added
    // was invisible here. A stub that omits the property under test cannot fail
    // the way production does.
    mockCharacteristic = {
      uuid: '0000beef-0000-1000-8000-00805f9b34fb',
      isSubscribed: true,
      writeValue: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    
    testDevice = { gatt: { connected: true } };
    
    // Create MockBluetooth instance
    mockBluetooth = new MockBluetooth('ws://localhost:25153', {
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
        serverUrl: 'ws://localhost:25153',
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

  // These run against a REAL MockBluetoothRemoteGATTCharacteristic built by the
  // same chain production uses. A stub cannot fail when the implementation
  // breaks — it only ever reports back the shape the test author assumed.
  describe('simulateNotification, against the real characteristic', () => {
    it('builds a real MockBluetoothRemoteGATTCharacteristic, not a stub', async () => {
      const characteristic = await realCharacteristic();

      // If this ever regresses to a plain object, every assertion below stops
      // being a claim about the production class.
      expect(characteristic).toBeInstanceOf(MockBluetoothRemoteGATTCharacteristic);
      expect(typeof characteristic.dispatchEvent).toBe('function');
    });

    it('delivers the payload to a handler registered via addEventListener', async () => {
      const characteristic = await realCharacteristic();
      const received = collectNotifications(characteristic);

      await mockBluetooth.testing.simulateNotification({
        characteristic,
        data: new Uint8Array([0xA7, 0xB3, 0x01, 0xFF])
      });

      expect(received).toEqual([[0xA7, 0xB3, 0x01, 0xFF]]);
    });

    it('preserves the byte range when the payload is a view into a larger buffer', async () => {
      // The bug this pins: `new DataView(data.buffer)` ignores byteOffset and
      // byteLength, so a subarray payload delivered the whole backing buffer.
      // Firehose payloads are subarrays.
      const characteristic = await realCharacteristic();
      const received = collectNotifications(characteristic);

      const backing = new Uint8Array([0xFF, 0xFF, 0x01, 0x02, 0x03, 0xFF]);
      await mockBluetooth.testing.simulateNotification({
        characteristic,
        data: backing.subarray(2, 5)
      });

      expect(received).toEqual([[0x01, 0x02, 0x03]]);
    });

    it('reaches the handler through dispatchEvent, the public path', async () => {
      // triggerNotification is private; dispatchEvent is the surface the Web
      // Bluetooth API actually exposes. Spy without replacing the behaviour, so
      // the delivery assertion still exercises the real implementation.
      const characteristic = await realCharacteristic();
      const received = collectNotifications(characteristic);
      const dispatchEvent = vi.spyOn(characteristic, 'dispatchEvent');

      await mockBluetooth.testing.simulateNotification({
        characteristic,
        data: new Uint8Array([0xA7, 0xB3, 0x04])
      });

      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      expect(dispatchEvent.mock.calls[0][0].type).toBe('characteristicvaluechanged');
      expect(received).toEqual([[0xA7, 0xB3, 0x04]]);
    });

    it('hands the handler a DataView-shaped value, which is what consumers read', async () => {
      // platform reads event.target.value as a DataView --
      // `new Uint8Array(value.buffer, value.byteOffset, value.byteLength)` and
      // getUint8. Pin that calling convention here rather than discovering a
      // mismatch against hardware, where it presents as silence.
      const characteristic = await realCharacteristic();
      let value: any = null;
      characteristic.addEventListener('characteristicvaluechanged', (event: any) => {
        value = event.target.value;
      });

      await mockBluetooth.testing.simulateNotification({
        characteristic,
        data: new Uint8Array([0xA7, 0xB3, 0x02])
      });

      expect(value).not.toBeNull();
      expect(typeof value.byteOffset).toBe('number');
      expect(value.byteLength).toBe(3);
      expect(value.getUint8(0)).toBe(0xA7);
      expect(value.getUint8(2)).toBe(0x02);
    });

    it('delivers a simulated notification identically to a real transport frame', async () => {
      // The whole premise of the testing API: an injected notification is
      // indistinguishable, at the handler, from one that arrived over the wire.
      // Scoped to a SUBSCRIBED characteristic since TRA-1153 -- see the pin below
      // for the unsubscribed case, where the two deliberately diverge.
      const characteristic = await realCharacteristic();
      const received = collectNotifications(characteristic);
      const frame = new Uint8Array([0xA7, 0xB3, 0x05, 0x00]);

      characteristic.handleTransportMessage(frame);
      await mockBluetooth.testing.simulateNotification({ characteristic, data: frame });

      expect(received).toHaveLength(2);
      expect(received[0]).toEqual(received[1]);
    });

    it('refuses to simulate on an unsubscribed characteristic, where the wire stays silent', async () => {
      // The one place the two paths deliberately disagree. A frame arriving for
      // an unsubscribed characteristic is something a radio really does, so the
      // transport path drops it silently. Calling this METHOD is a test author
      // asking for delivery, and dropping that silently would make the testing
      // API a check that cannot go red: no event, no error, and an assertion on
      // an empty array passing for the wrong reason.
      const device = await realDevice();
      const service = await device.gatt.getPrimaryService('0000f00d-0000-1000-8000-00805f9b34fb');
      const characteristic = await service.getCharacteristic('0000f00d-0000-1000-8000-00805f9b34fb');
      const received = collectNotifications(characteristic);

      characteristic.handleTransportMessage(new Uint8Array([0xA7]));
      expect(received).toEqual([]); // the wire: silent, as on hardware

      await expect(
        mockBluetooth.testing.simulateNotification({
          characteristic,
          data: new Uint8Array([0xA7])
        })
      ).rejects.toThrow(/not subscribed/i); // the instruction: named
    });

    it('delivers to every registered handler, and stops after removeEventListener', async () => {
      const characteristic = await realCharacteristic();
      const first: number[][] = [];
      const second: number[][] = [];
      const handlerFor = (sink: number[][]) => (event: any) => {
        const view = event.target.value;
        sink.push(Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)));
      };
      const secondHandler = handlerFor(second);

      characteristic.addEventListener('characteristicvaluechanged', handlerFor(first));
      characteristic.addEventListener('characteristicvaluechanged', secondHandler);

      await mockBluetooth.testing.simulateNotification({
        characteristic,
        data: new Uint8Array([0x01])
      });

      characteristic.removeEventListener('characteristicvaluechanged', secondHandler);

      await mockBluetooth.testing.simulateNotification({
        characteristic,
        data: new Uint8Array([0x02])
      });

      expect(first).toEqual([[0x01], [0x02]]);
      expect(second).toEqual([[0x01]]);
    });

    it('applies the delay before delivering', async () => {
      const characteristic = await realCharacteristic();
      const received = collectNotifications(characteristic);
      const startTime = Date.now();

      await mockBluetooth.testing.simulateNotification({
        characteristic,
        data: new Uint8Array([0xA7, 0xB3, 0x01, 0x00]),
        delay: 50
      });

      expect(Date.now() - startTime).toBeGreaterThanOrEqual(45); // timer tolerance
      expect(received).toEqual([[0xA7, 0xB3, 0x01, 0x00]]);
    });
  });

  // Characteristic identity is about to change under TRA-1153, which makes
  // startNotifications a real gate. These pin what the class does TODAY so that
  // change shows up as a deliberate diff rather than as silence in a consumer.
  describe('real characteristic identity', () => {
    // These two were written by TRA-1166 asserting the OPPOSITE, deliberately, so
    // that TRA-1153 would have to change them on purpose rather than by accident.
    // This is that moment: item 1 made identity stable, and both pins inverted.

    it('returns the same instance from every getCharacteristic call', async () => {
      const device = await realDevice();
      const service = await device.gatt.getPrimaryService('0000f00d-0000-1000-8000-00805f9b34fb');

      const first = await service.getCharacteristic('0000f00d-0000-1000-8000-00805f9b34fb');
      const second = await service.getCharacteristic('0000f00d-0000-1000-8000-00805f9b34fb');

      // Identity is stable, which is what a real getCharacteristic does and what
      // lets a subscription gate be keyed to the instance at all.
      expect(second).toBe(first);
    });

    it('keeps routing transport frames to a reference taken before a second lookup', async () => {
      // The bug, now fixed. MockBluetoothDevice.registerCharacteristic is a Map
      // keyed by UUID -- a fan-out registry, not the identity cache it resembles
      // -- so a second getCharacteristic used to evict the first from it. The
      // earlier reference kept its listeners and silently stopped receiving.
      const device = await realDevice();
      const service = await device.gatt.getPrimaryService('0000f00d-0000-1000-8000-00805f9b34fb');

      const first = await service.getCharacteristic('0000f00d-0000-1000-8000-00805f9b34fb');
      await first.startNotifications();
      const firstReceived = collectNotifications(first);
      const second = await service.getCharacteristic('0000f00d-0000-1000-8000-00805f9b34fb'); // used to evict
      const secondReceived = collectNotifications(second);

      // Drive the device's real routing path. No socket is ever opened, so the
      // handler the device registered on the transport is invoked directly.
      (device.transport as any).messageHandler({ type: 'data', data: [0x01, 0x02] });

      // Same object, so both sinks are just two listeners on one characteristic.
      expect(firstReceived).toEqual([[0x01, 0x02]]);
      expect(secondReceived).toEqual([[0x01, 0x02]]);
    });
  });

  // The fallback branches exist for characteristics this package does not own,
  // so a foreign shape is the subject here -- these are stubs by definition.
  describe('simulateNotification, foreign characteristic shapes', () => {
    it('falls back to a legacy simulateNotification method', async () => {
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

    it('names the problem when the characteristic exposes no known method', async () => {
      const badChar = {}; // no dispatchEvent, triggerNotification or simulateNotification

      await expect(mockBluetooth.testing.simulateNotification({
        characteristic: badChar as any,
        data: new Uint8Array([0x01, 0x02])
      })).rejects.toThrow('Unable to simulate notification');
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
/**
 * `testCommand` and the subscription gate (TRA-1153).
 *
 * TRA-1153 item 2 made notification delivery conditional on
 * `startNotifications()`. `testCommand` registers a listener and writes, and it
 * has never subscribed -- so against a real characteristic it waited for a frame
 * the mock would never deliver, then resolved `{ success: false, timeout: true }`
 * after the full timeout.
 *
 * That is this repo's most expensive failure class: a waiter whose condition
 * cannot be satisfied by what is actually sent, presenting as slowness rather
 * than as the missing call it is. It cost a hardware-debugging session on
 * 2026-08-27, and it was invisible to this suite because the stub characteristic
 * above does not model subscription at all.
 *
 * The fix matches `simulateNotification`, two methods away in the same object,
 * for the same reason: REFUSE, naming the situation. Swallowing it would leave a
 * check that cannot go red.
 */
describe('testCommand and the subscription gate', () => {
  const NOTIFY = '0000beef-0000-1000-8000-00805f9b34fb';

  function characteristic(subscribed: boolean) {
    return {
      uuid: NOTIFY,
      isSubscribed: subscribed,
      writeValue: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
  }

  function bluetooth() {
    return new MockBluetooth('ws://localhost:25153', {
      sessionId: 'gate-test',
      service: '0000f00d-0000-1000-8000-00805f9b34fb',
      timeout: 5000,
      onMultipleDevices: 'error'
    });
  }

  const options = (char: ReturnType<typeof characteristic>) => ({
    device: { gatt: { connected: true } },
    writeCharacteristic: char,
    notifyCharacteristic: char,
    command: new Uint8Array([0x01]),
    timeout: 100
  }) as any;

  it('refuses an unsubscribed characteristic, naming the missing call', async () => {
    const char = characteristic(false);
    await expect(bluetooth().testing.testCommand(options(char))).rejects.toThrow(/not subscribed/i);
  });

  it('does NOT write before refusing', async () => {
    // The half that matters on real hardware. Today it writes, sends bytes to a
    // live device, and only then times out -- so the device saw a command whose
    // response was always going to be dropped on the floor.
    const char = characteristic(false);
    await bluetooth().testing.testCommand(options(char)).catch(() => undefined);
    expect(char.writeValue).not.toHaveBeenCalled();
  });

  it('still proceeds when the characteristic IS subscribed', async () => {
    // The control. Without it, "refuses" is satisfiable by a method that
    // refuses everything.
    const char = characteristic(true);
    const result = await bluetooth().testing.testCommand(options(char));
    expect(char.writeValue).toHaveBeenCalledTimes(1);
    expect(result.timeout).toBe(true); // nothing fed it a frame; that is fine here
  });
});
