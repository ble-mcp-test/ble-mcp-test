import { describe, it, expect, afterEach } from 'vitest';
import { MockBluetooth, VERSION } from '../../src/index.js';
import { startStubBridge, type StubBridge } from './stub-bridge.js';

/**
 * The stub itself, tested. It is the fixture the whole of arm A stands on, so a
 * broken stub would present as the mock being broken -- an upstream failure
 * naming a downstream subsystem, which this codebase has paid for repeatedly.
 */
let bridge: StubBridge | undefined;

afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

function mockAgainst(url: string) {
  return new MockBluetooth(url, {
    service: '9800',
    write: '9900',
    notify: '9901',
    sessionId: 'stub-bridge-test',
    timeout: 5000,
    onMultipleDevices: 'error'
  });
}

describe('the stub bridge', () => {
  it('completes a REAL gatt.connect(), with no flag set by hand', async () => {
    bridge = await startStubBridge();
    const device: any = await mockAgainst(bridge.url).requestDevice();

    expect(device.gatt.connected).toBe(false);
    await device.gatt.connect();
    expect(device.gatt.connected).toBe(true);

    await device.gatt.disconnect();
  });

  it('receives the connect parameters, including the version marker', async () => {
    bridge = await startStubBridge();
    const device: any = await mockAgainst(bridge.url).requestDevice();
    await device.gatt.connect();

    expect(bridge.latest!.params.get('_mv')).toBe(VERSION);
    expect(bridge.latest!.params.get('service')).toBe('9800');
    expect(bridge.latest!.params.get('session')).toBe('stub-bridge-test');

    await device.gatt.disconnect();
  });

  it('records what the client wrote', async () => {
    bridge = await startStubBridge();
    const device: any = await mockAgainst(bridge.url).requestDevice();
    await device.gatt.connect();
    const service = await device.gatt.getPrimaryService('9800');
    const write = await service.getCharacteristic('9900');

    await write.writeValue(new Uint8Array([0xa7, 0xb3, 0x02]));
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(bridge.latest!.writes).toEqual([[0xa7, 0xb3, 0x02]]);

    await device.gatt.disconnect();
  });

  it('pushes a notification the client can receive', async () => {
    bridge = await startStubBridge();
    const device: any = await mockAgainst(bridge.url).requestDevice();
    await device.gatt.connect();
    const service = await device.gatt.getPrimaryService('9800');
    const notify = await service.getCharacteristic('9901');

    const seen: number[][] = [];
    notify.addEventListener('characteristicvaluechanged', (event: any) =>
      seen.push(Array.from(new Uint8Array(
        event.target.value.buffer,
        event.target.value.byteOffset,
        event.target.value.byteLength
      )))
    );
    await notify.startNotifications();

    bridge.notify([0x01, 0x02, 0x03]);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(seen).toEqual([[0x01, 0x02, 0x03]]);

    await device.gatt.disconnect();
  });

  it('does NOT echo writes unless asked', async () => {
    // A bridge does not echo. A stub that did would let a suite assert against
    // its own double and call it a round trip.
    bridge = await startStubBridge();
    const device: any = await mockAgainst(bridge.url).requestDevice();
    await device.gatt.connect();
    const service = await device.gatt.getPrimaryService('9800');
    const notify = await service.getCharacteristic('9901');
    const write = await service.getCharacteristic('9900');

    const seen: unknown[] = [];
    notify.addEventListener('characteristicvaluechanged', (e: unknown) => seen.push(e));
    await notify.startNotifications();

    await write.writeValue(new Uint8Array([0xff]));
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(seen).toEqual([]);

    await device.gatt.disconnect();
  });
});
