/**
 * One peripheral is one `BluetoothDevice` for the life of the realm (TRA-1255).
 *
 * ## What the conformance suite can and cannot say about this
 *
 * `chain/second-request-returns-the-same-device` states the clause, and it runs
 * in both arms — that is what makes it a fidelity claim rather than a claim
 * about the mock. But the contract is written against the CLIENT SURFACE, so it
 * can only compare object references. Two things that matter here are invisible
 * from there:
 *
 * 1. **How many sockets a second `connect()` opens.** The spec resolves it with
 *    the existing server and attempts no second link; a mock that opened a
 *    second one would satisfy every assertion the contract can make while
 *    taking the bridge's single writer slot twice and being refused as busy by
 *    its own session. That is the over-satisfiable shape: the defect passes
 *    through a clean baseline.
 * 2. **That the identity map is keyed on the peripheral rather than on the
 *    realm.** A `requestDevice` that ignored its arguments and returned one
 *    device for everything would also pass the contract check, because the
 *    contract only ever asks for one peripheral.
 *
 * Both need the stub bridge's connection log or two different filters, and
 * neither is available to a check that has to run against real Chromium. So they
 * are asserted here, against arm A's own scaffolding, and the contract keeps the
 * half that can be asked of both implementations.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockBluetooth, updateMockConfig } from '../../src/index.js';
import { startStubBridge, type StubBridge } from '../conformance/stub-bridge.js';

const SERVICE = '0000f00d-0000-1000-8000-00805f9b34fb';
const OTHER_SERVICE = '0000feed-0000-1000-8000-00805f9b34fb';
const NOTIFY = '0000beef-0000-1000-8000-00805f9b34fb';

let bridge: StubBridge;

beforeEach(async () => {
  bridge = await startStubBridge();
  updateMockConfig({ postDisconnectDelay: 0 });
});

afterEach(async () => {
  updateMockConfig(null);
  await bridge.close();
});

function mock(): MockBluetooth {
  return new MockBluetooth(bridge.url, {
    service: SERVICE,
    notify: NOTIFY,
    sessionId: 'device-identity',
    onMultipleDevices: 'error'
  });
}

describe('the device instance map', () => {
  it('returns the same device for the same peripheral', async () => {
    const bluetooth = mock();
    const first: any = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
    const second: any = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
    expect(second).toBe(first);
  });

  it('returns a different device for a different peripheral', async () => {
    // The key is the selection tuple, so this is what keeps the map from
    // degenerating into "one device per MockBluetooth, whatever you asked for".
    // Without it the check above passes against a `requestDevice` that ignores
    // its arguments entirely.
    const bluetooth = mock();
    const first: any = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
    const other: any = await bluetooth.requestDevice({ filters: [{ services: [OTHER_SERVICE] }] });
    expect(other).not.toBe(first);
    expect(other.bleConfig.service).toBe(OTHER_SERVICE);
  });

  it('is per realm: a second MockBluetooth mints its own device', async () => {
    // `navigator.bluetooth` is the realm, and two of them are two pages. A map
    // hoisted to module scope would tie two pages' device objects together and
    // survive `injectWebBluetoothMock` replacing the instance.
    const first: any = await mock().requestDevice({ filters: [{ services: [SERVICE] }] });
    const second: any = await mock().requestDevice({ filters: [{ services: [SERVICE] }] });
    expect(second).not.toBe(first);
  });
});

describe('connect() on an already-connected server', () => {
  it('opens no second socket', async () => {
    // The assertion the contract cannot make. `connect()` returning `this` is
    // true of both the fixed and the broken implementation; the connection count
    // is what tells them apart, and against the real bridge the second socket is
    // refused `Device is busy` by the caller's own session.
    const bluetooth = mock();
    const device: any = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });

    const server = await device.gatt.connect();
    expect(bridge.connections.length).toBe(1);

    const again = await device.gatt.connect();
    expect(again).toBe(server);
    expect(bridge.connections.length).toBe(1);
  });

  it('opens a second socket once the first has been disconnected', async () => {
    // The control for the check above: it must be the CONNECTED state doing the
    // work, not a mock that has stopped reconnecting at all.
    const bluetooth = mock();
    const device: any = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });

    await device.gatt.connect();
    await device.gatt.disconnect();
    await device.gatt.connect();

    expect(bridge.connections.length).toBe(2);
  });
});
