import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockBluetooth } from '../../src/mock-bluetooth.js';

/**
 * TRA-1153 items 1-4: make the mock stop diverging from the real BLE lifecycle.
 *
 * The premise, from the design doc: the app conforms to the native lifecycle
 * (connect -> discover -> subscribe -> write); the mock flattens all of that into
 * one implicit op. Every divergence is a way a test can pass here and fail on a
 * real radio, or vice versa.
 *
 * These are deliberately BREAKING behaviour changes behind a shape platform
 * treats as frozen. The shape is frozen; the behaviour was never the promise.
 */

const CONFIG = { service: '9800', write: '9900', notify: '9901' };

async function connectedServer() {
  const mock = new MockBluetooth('ws://localhost:15104', {
    ...CONFIG,
    sessionId: 'lifecycle-test',
    timeout: 5000
  } as any);
  const device: any = await mock.requestDevice();
  // Set the flag rather than calling connect(): a real connect needs a live
  // bridge, and none of the lifecycle behaviour under test touches the wire.
  // Same approach as testing-api.test.ts.
  device.gatt.connected = true;
  return { mock, device, server: device.gatt };
}

beforeEach(() => {
  // The transport is never opened: WebSocketTransport's constructor only stores a
  // URL and onMessage only stores a callback, so a real instance is affordable
  // here. Anything that would actually reach the wire is stubbed per-test.
  vi.restoreAllMocks();
});

// --- item 1: identity ---------------------------------------------------------

describe('identity is stable per UUID', () => {
  it('returns the same characteristic instance for the same UUID', async () => {
    const { server } = await connectedServer();
    const service = await server.getPrimaryService('9800');
    const first = await service.getCharacteristic('9901');
    const second = await service.getCharacteristic('9901');
    expect(second).toBe(first);
  });

  it('returns the same service instance for the same UUID', async () => {
    const { server } = await connectedServer();
    expect(await server.getPrimaryService('9800')).toBe(await server.getPrimaryService('9800'));
  });

  it('still returns distinct instances for distinct UUIDs', async () => {
    const { server } = await connectedServer();
    const service = await server.getPrimaryService('9800');
    expect(await service.getCharacteristic('9901')).not.toBe(
      await service.getCharacteristic('9900')
    );
  });

  it('does not evict the first reference from the routing table', async () => {
    // THE BUG. `characteristics` is a fan-out registry keyed by UUID, not the
    // identity cache it resembles -- so a second getCharacteristic used to
    // overwrite the entry, and the first reference kept its listeners while
    // silently receiving nothing. No error, anywhere.
    const { device, server } = await connectedServer();
    const service = await server.getPrimaryService('9800');

    const first = await service.getCharacteristic('9901');
    const firstSaw: number[][] = [];
    first.addEventListener('characteristicvaluechanged', (e: any) =>
      firstSaw.push(Array.from(new Uint8Array(e.target.value.buffer)))
    );

    await first.startNotifications();
    await service.getCharacteristic('9901'); // the call that used to evict

    (device as any).handleTransportMessage?.(new Uint8Array([1, 2, 3]));
    (server as any).device.characteristics.get('9901')?.handleTransportMessage(
      new Uint8Array([1, 2, 3])
    );

    expect(firstSaw).toEqual([[1, 2, 3]]);
  });
});

// --- item 2: subscription gating ----------------------------------------------

describe('startNotifications / stopNotifications actually gate delivery', () => {
  it('delivers nothing before startNotifications()', async () => {
    const { server } = await connectedServer();
    const service = await server.getPrimaryService('9800');
    const char = await service.getCharacteristic('9901');

    const seen: unknown[] = [];
    char.addEventListener('characteristicvaluechanged', (e: any) => seen.push(e));
    char.handleTransportMessage(new Uint8Array([0xa7]));

    // A listener without a subscription receives nothing on a real radio. The
    // mock used to deliver anyway, which is what let a consumer forget to
    // subscribe and still pass.
    expect(seen).toEqual([]);
  });

  it('delivers once subscribed', async () => {
    const { server } = await connectedServer();
    const service = await server.getPrimaryService('9800');
    const char = await service.getCharacteristic('9901');

    const seen: unknown[] = [];
    char.addEventListener('characteristicvaluechanged', (e: any) => seen.push(e));
    await char.startNotifications();
    char.handleTransportMessage(new Uint8Array([0xa7]));

    expect(seen).toHaveLength(1);
  });

  it('stops delivering after stopNotifications()', async () => {
    const { server } = await connectedServer();
    const service = await server.getPrimaryService('9800');
    const char = await service.getCharacteristic('9901');

    const seen: unknown[] = [];
    char.addEventListener('characteristicvaluechanged', (e: any) => seen.push(e));
    await char.startNotifications();
    char.handleTransportMessage(new Uint8Array([1]));
    await char.stopNotifications();
    char.handleTransportMessage(new Uint8Array([2]));

    expect(seen).toHaveLength(1);
  });

  it('rejects stopNotifications() on a characteristic that never started', async () => {
    // Platform wraps this call in an empty catch. That catch is dead today
    // because the method is a no-op; making it a real gate makes it reachable.
    // Rejecting with a message that NAMES the situation is what makes their
    // eventual unwrapping of that catch worth anything.
    const { server } = await connectedServer();
    const service = await server.getPrimaryService('9800');
    const char = await service.getCharacteristic('9901');

    await expect(char.stopNotifications()).rejects.toThrow(/not subscribed/i);
  });
});

// --- item 3: real DataView ----------------------------------------------------

describe('dispatch delivers a real DataView', () => {
  it('hands the handler an actual DataView, not a duck-typed object', async () => {
    const { server } = await connectedServer();
    const service = await server.getPrimaryService('9800');
    const char = await service.getCharacteristic('9901');

    let value: any;
    char.addEventListener('characteristicvaluechanged', (e: any) => {
      value = e.target.value;
    });
    await char.startNotifications();
    char.handleTransportMessage(new Uint8Array([0xa7, 0xb3]));

    // `instanceof` is the assertion that matters: the duck-typed shape carried
    // buffer/byteLength/byteOffset/getUint8 and would satisfy any structural
    // check while failing anything that calls a method it did not think to fake.
    expect(value).toBeInstanceOf(DataView);
  });

  it('supports DataView methods the duck-typed object never had', async () => {
    const { server } = await connectedServer();
    const service = await server.getPrimaryService('9800');
    const char = await service.getCharacteristic('9901');

    let value: DataView | undefined;
    char.addEventListener('characteristicvaluechanged', (e: any) => {
      value = e.target.value;
    });
    await char.startNotifications();
    char.handleTransportMessage(new Uint8Array([0x12, 0x34]));

    expect(value!.getUint16(0)).toBe(0x1234);
  });

  it('honours the byte range of a view into a larger buffer', async () => {
    const { server } = await connectedServer();
    const service = await server.getPrimaryService('9800');
    const char = await service.getCharacteristic('9901');

    let value: DataView | undefined;
    char.addEventListener('characteristicvaluechanged', (e: any) => {
      value = e.target.value;
    });
    await char.startNotifications();
    char.handleTransportMessage(new Uint8Array([0xff, 1, 2, 3, 0xff]).subarray(1, 4));

    expect(value!.byteLength).toBe(3);
    expect(Array.from(new Uint8Array(value!.buffer, value!.byteOffset, value!.byteLength))).toEqual(
      [1, 2, 3]
    );
  });
});

// --- item 4: synchronous disconnect -------------------------------------------

describe('gatt.disconnect() is synchronous with respect to connected', () => {
  it('reports connected === false before the returned promise settles', async () => {
    const { server } = await connectedServer();
    expect(server.connected).toBe(true);

    const pending = server.disconnect();
    // The assertion is deliberately BEFORE the await. On a real GATT server the
    // flag flips immediately; the mock used to leave it true until the socket
    // close resolved, so a consumer checking `connected` in a teardown path saw
    // a server that was already gone reporting itself present.
    expect(server.connected).toBe(false);
    await pending;
    expect(server.connected).toBe(false);
  });

  it('is safe for a consumer that disconnects while already disconnected', async () => {
    const { server } = await connectedServer();
    await server.disconnect();
    await expect(server.disconnect()).resolves.toBeUndefined();
  });
});
