import { describe, it, expect, afterEach } from 'vitest';
import { MockBluetooth } from '../../src/index.js';
import { startStubBridge, type StubBridge } from '../conformance/stub-bridge.js';

/**
 * The mock refuses a write mode the peripheral does not advertise.
 *
 * Real Chrome throws NotSupportedError when `writeValueWithoutResponse()` is
 * called on a characteristic without the write-without-response property. Until
 * the bridge put `write_properties` on the `connected` frame the mock could not
 * see the property at all, so it accepted the call -- **the one place the mock
 * was LOOSER than the API it doubles**, where a call passes here and throws in
 * the browser. That is TRA-1187's motivating example pointed the other way: a
 * consumer writing a legal-looking call, conformance staying green, Chrome
 * throwing.
 *
 * Not in the conformance suite because arm A builds one provider for the whole
 * run, and this needs three differently-configured peripherals.
 */
const SERVICE = '0000f00d-0000-1000-8000-00805f9b34fb';
const WRITE = '0000c0de-0000-1000-8000-00805f9b34fb';
const NOTIFY = '0000beef-0000-1000-8000-00805f9b34fb';

let bridge: StubBridge | undefined;
afterEach(async () => { await bridge?.close(); bridge = undefined; });

async function characteristicOn(writeProperties: string[]) {
  bridge = await startStubBridge({ writeProperties });
  const bluetooth = new MockBluetooth(bridge.url, {
    service: SERVICE,
    write: WRITE,
    notify: NOTIFY,
    sessionId: 'write-properties-gate',
    timeout: 5000,
    onMultipleDevices: 'error'
  });
  const device: any = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
  const server = await device.gatt.connect();
  const service: any = await server.getPrimaryService(SERVICE);
  return service.getCharacteristic(WRITE);
}

describe('writeValueWithoutResponse gates on the advertised properties', () => {
  it('REJECTS when the peripheral advertises write only -- the CS108 case', async () => {
    const characteristic = await characteristicOn(['write']);
    await expect(
      characteristic.writeValueWithoutResponse(new Uint8Array([0x01]))
    ).rejects.toThrow(/not supported|NotSupportedError/i);
  });

  it('names what the peripheral DOES advertise, so the caller can choose', async () => {
    const characteristic = await characteristicOn(['write']);
    // "not supported" alone sends someone to the wrong question. The message
    // carries the actual property list and the two legal alternatives.
    await expect(
      characteristic.writeValueWithoutResponse(new Uint8Array([0x01]))
    ).rejects.toThrow(/\[write\]/);
  });

  it('allows it when the peripheral advertises the property', async () => {
    const characteristic = await characteristicOn(['write', 'write_without_response']);
    await expect(
      characteristic.writeValueWithoutResponse(new Uint8Array([0x01]))
    ).resolves.toBeUndefined();
  });

  it('does NOT gate when the bridge reports no properties at all', async () => {
    // Absent is not empty. A bridge that cannot answer must not read as a device
    // that supports nothing -- that would turn a missing field into a hard
    // failure on every write, which is worse than the looseness it replaced.
    const characteristic = await characteristicOn([]);
    await expect(
      characteristic.writeValueWithoutResponse(new Uint8Array([0x01]))
    ).resolves.toBeUndefined();
  });
});
