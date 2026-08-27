import { describe, it, expect } from 'vitest';
import { MockBluetooth } from '../../src/mock-bluetooth.js';

/**
 * The identity cache must stay DEVICE-scoped. This pins a constraint, not a feature.
 *
 * TRA-1153 item 1 made `getCharacteristic`/`getPrimaryService` identity-stable per
 * UUID, which is correct and what platform wants. But the SCOPE of that cache is
 * load-bearing in a way nothing in the code announces:
 *
 *   platform's transport re-runs its whole connect chain on reconnect --
 *   getPrimaryService, getCharacteristic x2, startNotifications, addEventListener.
 *   Today that is safe because `requestDevice` mints a FRESH device every call, so
 *   a reconnect gets fresh characteristics and cannot collide with the previous
 *   session's objects.
 *
 * Hoist the cache above the device -- key it on the MockBluetooth, or on serverUrl,
 * which is an easy and superficially tidy refactor -- and the reconnect gets the
 * SAME characteristic object back. Listener dedup now stops that becoming doubled
 * delivery, but the objects would still be shared across sessions, carrying
 * subscription state and buffered handlers from a connection that has ended.
 *
 * So this test exists to FAIL if someone makes that refactor. It is not testing
 * that caching works -- mock-lifecycle.test.ts does that.
 */

const CONFIG = { service: '9800', write: '9900', notify: '9901' };

function mock(sessionId = 'device-scope-test') {
  return new MockBluetooth('ws://localhost:25153', {
    ...CONFIG,
    sessionId,
    timeout: 5000
  } as any);
}

async function connectedDevice(m: MockBluetooth) {
  const device: any = await m.requestDevice();
  device.gatt.connected = true;
  return device;
}

describe('the identity cache is scoped to the device instance', () => {
  it('gives a SECOND requestDevice on the same mock a distinct device', async () => {
    const m = mock();
    expect(await connectedDevice(m)).not.toBe(await connectedDevice(m));
  });

  it('gives that second device DISTINCT service and characteristic objects', async () => {
    const m = mock();
    const first = await connectedDevice(m);
    const second = await connectedDevice(m);

    const firstService = await first.gatt.getPrimaryService('9800');
    const secondService = await second.gatt.getPrimaryService('9800');
    expect(secondService).not.toBe(firstService);

    const firstChar = await firstService.getCharacteristic('9901');
    const secondChar = await secondService.getCharacteristic('9901');
    expect(secondChar).not.toBe(firstChar);
  });

  it('does not leak subscription state from the previous session', async () => {
    const m = mock();
    const first = await connectedDevice(m);
    const firstChar: any = await (await first.gatt.getPrimaryService('9800')).getCharacteristic('9901');
    await firstChar.startNotifications();

    const second = await connectedDevice(m);
    const secondChar: any = await (await second.gatt.getPrimaryService('9800')).getCharacteristic('9901');

    // A fresh session starts unsubscribed. If this ever reads true, the cache has
    // been hoisted and the new connection inherited the old one's gate.
    expect(secondChar.subscribed).toBe(false);
  });

  it('still caches WITHIN one device -- the constraint is scope, not absence', async () => {
    const device = await connectedDevice(mock());
    const service = await device.gatt.getPrimaryService('9800');
    expect(await device.gatt.getPrimaryService('9800')).toBe(service);
    expect(await service.getCharacteristic('9901')).toBe(await service.getCharacteristic('9901'));
  });
});
