/**
 * `gattserverdisconnected` on an explicit `gatt.disconnect()` (TRA-1210).
 *
 * The Web Bluetooth spec routes BOTH disconnect paths through one algorithm.
 * `disconnect()` (index.bs:3221) aborts if `connected` is already false, and
 * otherwise runs "clean up the disconnected device" (index.bs:4417) — whose
 * final step (`:4449`) fires `gattserverdisconnected` at the device. The
 * transport-drop path (§6.6.3) reaches the same algorithm. There is no quiet
 * path for a page-initiated disconnect.
 *
 * ## Why these checks live here and not only in the conformance suite
 *
 * The mock already fired the event on an explicit disconnect, by accident: the
 * transport synthesises a `disconnected` message in `onclose`, and a
 * locally-initiated `ws.close()` reaches `onclose` like any other. But it landed
 * whenever the socket close round-tripped, which is AFTER `disconnect()`
 * resolves. It only appeared ordered because `postDisconnectDelay` defaults to
 * 250ms and slept over the gap — a delay that exists to let the BRIDGE release
 * the device, for no reason connected to this event at all.
 *
 * So every check below pins `postDisconnectDelay` to 0. At the default it passes
 * whether or not the fix is present: green on a coincidence, unable to go red.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockBluetooth, updateMockConfig } from '../../src/index.js';
import { startStubBridge, type StubBridge } from '../conformance/stub-bridge.js';

const SERVICE = '0000f00d-0000-1000-8000-00805f9b34fb';

let bridge: StubBridge;

async function connectedDevice() {
  const bluetooth = new MockBluetooth(bridge.url, {
    service: SERVICE,
    sessionId: `explicit-disconnect-${Math.random().toString(36).slice(2)}`,
    onMultipleDevices: 'error'
  });
  const device: any = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
  const server = await device.gatt.connect();
  return { device, server };
}

/** Long enough for a socket close to round-trip, which is what we are outrunning. */
const settle = () => new Promise(resolve => setTimeout(resolve, 100));

beforeEach(async () => {
  bridge = await startStubBridge();
  updateMockConfig({ postDisconnectDelay: 0 });
});

afterEach(async () => {
  updateMockConfig(null);
  await bridge.close();
});

describe('gattserverdisconnected on an explicit disconnect', () => {
  it('has fired by the time disconnect() resolves', async () => {
    const { device, server } = await connectedDevice();
    let calls = 0;
    device.addEventListener('gattserverdisconnected', () => { calls += 1; });

    await server.disconnect();

    // No settle. The spec fires the event inside disconnect()'s own steps,
    // before the connection is torn down — so a consumer that awaits the call
    // and then reads its own state has already been told.
    expect(calls).toBe(1);
  });

  it('fires exactly once — the socket close does not fire it again', async () => {
    const { device, server } = await connectedDevice();
    let calls = 0;
    device.addEventListener('gattserverdisconnected', () => { calls += 1; });

    await server.disconnect();
    await settle();

    // Both paths converge on one cleanup algorithm, and the transport's
    // synthesised `disconnected` arrives after it has already run.
    expect(calls).toBe(1);
  });

  it('does not fire on a second disconnect() of an already-disconnected server', async () => {
    const { device, server } = await connectedDevice();
    await server.disconnect();

    let calls = 0;
    device.addEventListener('gattserverdisconnected', () => { calls += 1; });
    await server.disconnect();
    await settle();

    // disconnect() step 2: abort if `connected` is already false.
    expect(calls).toBe(0);
  });

  it('leaves gatt.connected false once it has fired', async () => {
    const { device, server } = await connectedDevice();
    let connectedInsideHandler: boolean | undefined;
    device.addEventListener('gattserverdisconnected', () => {
      connectedInsideHandler = server.connected;
    });

    await server.disconnect();

    // Step 1 of the cleanup algorithm sets `gatt.connected` to false; the event
    // is step 9. A handler must never observe the server still reporting itself
    // present — the mock contradicting itself across two of its own members.
    expect(connectedInsideHandler).toBe(false);
    expect(server.connected).toBe(false);
  });

  it('still fires exactly once on a transport-level drop', async () => {
    const { device, server } = await connectedDevice();
    let calls = 0;
    device.addEventListener('gattserverdisconnected', () => { calls += 1; });

    bridge.drop();
    await settle();

    // The limb that was never in question. Guarding the cleanup on the
    // connected flag must not silence it.
    expect(calls).toBe(1);
    expect(server.connected).toBe(false);
  });
});
