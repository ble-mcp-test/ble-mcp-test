/**
 * Delivery survives a reconnect (found while fixing TRA-1210).
 *
 * The device's post-handshake message handler used to be wired ONCE per device,
 * lazily, by the first `getCharacteristic()`. Both halves of that were wrong,
 * and this file pins the second.
 *
 * `WebSocketTransport.onMessage` binds `ws.onmessage` on the socket that exists
 * when it is called, and `transport.connect()` installs a handshake-only
 * `onmessage` on every NEW socket — one that recognises `connected`, `error`
 * and `warning`, and ignores `data`. So the second connect left the fresh
 * socket on the handshake handler and notifications stopped arriving: silently,
 * with `gatt.connected === true`, a live subscription, and a bridge sending
 * frames into nothing.
 *
 * It stayed invisible because the characteristic cache hid it. A reconnecting
 * consumer calls `getCharacteristic()` again and got the CACHED instance back,
 * so the lazy wiring never re-ran — the one call that would have repaired it was
 * the call whose result made it unnecessary to make.
 *
 * ## What TRA-1255 changed underneath this file
 *
 * That cache is now emptied on disconnect, which is what the spec's "clean up
 * the disconnected device" requires (index.bs:4417, step 5). So a reconnect
 * yields a NEW characteristic object, and this file asserted the opposite —
 * `expect(second.characteristic).toBe(first.characteristic)` — as intended
 * behaviour, in the same tree where the conformance suite called the same fact a
 * hazard. Only one of those could be right; the spec settles which.
 *
 * The subject is unchanged and is the reason the file still exists: after a
 * reconnect, frames must reach a consumer that re-derived and re-subscribed.
 * Nothing about the wiring bug is any less possible now — it is if anything
 * easier to reintroduce, because the repaired path is the one that now runs
 * every time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockBluetooth, updateMockConfig } from '../../src/index.js';
import { startStubBridge, type StubBridge } from '../conformance/stub-bridge.js';

const SERVICE = '0000f00d-0000-1000-8000-00805f9b34fb';
const NOTIFY = '0000beef-0000-1000-8000-00805f9b34fb';

let bridge: StubBridge;
const settle = () => new Promise(resolve => setTimeout(resolve, 100));

beforeEach(async () => {
  bridge = await startStubBridge();
  updateMockConfig({ postDisconnectDelay: 0 });
});

afterEach(async () => {
  updateMockConfig(null);
  await bridge.close();
});

describe('delivery after a reconnect', () => {
  it('notifications still arrive on the second connection', async () => {
    const bluetooth = new MockBluetooth(bridge.url, {
      service: SERVICE,
      notify: NOTIFY,
      sessionId: 'reconnect-delivery',
      onMultipleDevices: 'error'
    });
    const device: any = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });

    const subscribe = async () => {
      const server = await device.gatt.connect();
      const characteristic = await (await server.getPrimaryService(SERVICE)).getCharacteristic(NOTIFY);
      await characteristic.startNotifications();
      return { server, characteristic };
    };

    const first = await subscribe();
    let received = 0;
    first.characteristic.addEventListener('characteristicvaluechanged', () => { received += 1; });

    bridge.notify([0x01]);
    await settle();
    expect(received).toBe(1);

    await first.server.disconnect();
    await settle();

    // A NEW characteristic instance: the disconnect emptied the attribute cache,
    // as "clean up the disconnected device" step 5 requires. Asserted here and
    // not only in the conformance suite because it is what makes the rest of
    // this test a real question — against the cached instance the listener below
    // would already be attached, and delivery would prove nothing about whether
    // the transport handler was rebound.
    const second = await subscribe();
    expect(second.characteristic).not.toBe(first.characteristic);
    second.characteristic.addEventListener('characteristicvaluechanged', () => { received += 1; });

    bridge.notify([0x02]);
    await settle();

    // 2 carries BOTH halves, which is why the counter is shared rather than one
    // per instance. The new characteristic delivered (2 > 1), and the one from
    // the ended connection did not — it still holds its listener and its
    // subscription, so had the disconnect left it in the device's fan-out
    // registry this single frame would have counted twice and read 3. A
    // reconnect that delivers everything twice presents as duplicated device
    // frames, i.e. as a reader fault.
    expect(received).toBe(2);
  });

  it('gattserverdisconnected still fires on a drop after a reconnect', async () => {
    const bluetooth = new MockBluetooth(bridge.url, {
      service: SERVICE,
      sessionId: 'reconnect-disconnect-event',
      onMultipleDevices: 'error'
    });
    const device: any = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });

    const first = await device.gatt.connect();
    await first.disconnect();
    await settle();

    const second = await device.gatt.connect();
    let calls = 0;
    device.addEventListener('gattserverdisconnected', () => { calls += 1; });

    bridge.drop();
    await settle();

    expect(calls).toBe(1);
    expect(second.connected).toBe(false);
  });

  it('a connection with no characteristic still reports its own drop', async () => {
    // The other half of the lazy wiring. `gattserverdisconnected` is produced by
    // the device's message handler, so gating that handler on the first
    // `getCharacteristic()` made the event conditional on an unrelated call: a
    // consumer that connected purely to watch the link saw nothing, ever.
    const bluetooth = new MockBluetooth(bridge.url, {
      service: SERVICE,
      sessionId: 'no-characteristic',
      onMultipleDevices: 'error'
    });
    const device: any = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
    const server = await device.gatt.connect();

    let calls = 0;
    device.addEventListener('gattserverdisconnected', () => { calls += 1; });

    bridge.drop();
    await settle();

    expect(calls).toBe(1);
    expect(server.connected).toBe(false);
  });
});
