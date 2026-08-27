import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockBluetooth } from '../../src/mock-bluetooth.js';

/**
 * Listener semantics: dedup, `once`, and refusing options we do not implement.
 *
 * All three exist because of one hazard platform identified on 2026-08-27. Their
 * transport binds its notification handler ONCE in its constructor, then re-runs
 * the whole connect chain on every reconnect. Against a bare `push`, the second
 * connect registers the identical handler on the same instance again and every
 * notification is delivered TWICE -- silently, presenting as duplicated device
 * frames, which reads as a reader or bridge fault rather than a listener bug.
 *
 * The DOM does not have this problem: it drops a duplicate (type, listener,
 * capture). Now neither does the mock.
 */

const CONFIG = { service: '9800', write: '9900', notify: '9901' };

async function connectedServer() {
  const mock = new MockBluetooth('ws://localhost:25153', {
    ...CONFIG,
    sessionId: 'listener-semantics-test',
    timeout: 5000
  } as any);
  const device: any = await mock.requestDevice();
  device.gatt.connected = true;
  return { mock, device, server: device.gatt };
}

async function subscribedCharacteristic() {
  const { server, device, mock } = await connectedServer();
  const service = await server.getPrimaryService('9800');
  const characteristic: any = await service.getCharacteristic('9901');
  await characteristic.startNotifications();
  return { mock, device, server, characteristic };
}

function frame(bytes: number[]) {
  const data = new Uint8Array(bytes);
  return {
    type: 'characteristicvaluechanged',
    target: { value: new DataView(data.buffer, data.byteOffset, data.byteLength) }
  } as unknown as Event;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('addEventListener dedups identical (type, handler) pairs', () => {
  it('delivers ONCE to a handler registered three times', async () => {
    const { characteristic } = await subscribedCharacteristic();
    const handler = vi.fn();

    characteristic.addEventListener('characteristicvaluechanged', handler);
    characteristic.addEventListener('characteristicvaluechanged', handler);
    characteristic.addEventListener('characteristicvaluechanged', handler);

    characteristic.dispatchEvent(frame([0xa7, 0xb3]));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('is the reconnect case: re-registering a stable bound handler does not double', async () => {
    const { characteristic } = await subscribedCharacteristic();
    // The consumer binds ONCE in its constructor, so the reference is stable
    // across reconnects -- this is that exact reference, registered twice.
    const bound = vi.fn();
    characteristic.addEventListener('characteristicvaluechanged', bound);
    characteristic.addEventListener('characteristicvaluechanged', bound);

    characteristic.dispatchEvent(frame([0x01]));
    expect(bound).toHaveBeenCalledTimes(1);
  });

  it('still keeps DISTINCT handlers, which is not the same question', async () => {
    const { characteristic } = await subscribedCharacteristic();
    const a = vi.fn();
    const b = vi.fn();
    characteristic.addEventListener('characteristicvaluechanged', a);
    characteristic.addEventListener('characteristicvaluechanged', b);

    characteristic.dispatchEvent(frame([0x01]));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('{ once: true } is honoured rather than silently dropped', () => {
  it('fires exactly once across two dispatches', async () => {
    const { characteristic } = await subscribedCharacteristic();
    const handler = vi.fn();
    characteristic.addEventListener('characteristicvaluechanged', handler, { once: true });

    characteristic.dispatchEvent(frame([0x01]));
    characteristic.dispatchEvent(frame([0x02]));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('leaves a non-once handler registered alongside it', async () => {
    const { characteristic } = await subscribedCharacteristic();
    const once = vi.fn();
    const persistent = vi.fn();
    characteristic.addEventListener('characteristicvaluechanged', once, { once: true });
    characteristic.addEventListener('characteristicvaluechanged', persistent);

    characteristic.dispatchEvent(frame([0x01]));
    characteristic.dispatchEvent(frame([0x02]));

    expect(once).toHaveBeenCalledTimes(1);
    expect(persistent).toHaveBeenCalledTimes(2);
  });
});

describe('options we do not implement are REFUSED, not ignored', () => {
  it('throws on an unsupported option', async () => {
    const { characteristic } = await subscribedCharacteristic();
    expect(() =>
      characteristic.addEventListener('characteristicvaluechanged', vi.fn(), { passive: true })
    ).toThrow(/not\s+implemented/i);
  });

  it('throws on the capture flag, in both spellings', async () => {
    const { characteristic } = await subscribedCharacteristic();
    expect(() =>
      characteristic.addEventListener('characteristicvaluechanged', vi.fn(), true)
    ).toThrow(/capture/i);
    expect(() =>
      characteristic.addEventListener('characteristicvaluechanged', vi.fn(), { capture: true })
    ).toThrow(/not\s+implemented/i);
  });

  it('accepts absence, false, and the options it does implement', async () => {
    const { characteristic } = await subscribedCharacteristic();
    expect(() => characteristic.addEventListener('characteristicvaluechanged', vi.fn())).not.toThrow();
    expect(() => characteristic.addEventListener('characteristicvaluechanged', vi.fn(), false)).not.toThrow();
    expect(() =>
      characteristic.addEventListener('characteristicvaluechanged', vi.fn(), { once: true })
    ).not.toThrow();
  });
});

/**
 * `gattserverdisconnected` fires on the DEVICE, not the server -- correct per Web
 * Bluetooth, and worth stating because the obvious guess is the server.
 *
 * It is also raised only by a TRANSPORT-level drop, never by an explicit
 * `gatt.disconnect()`. Driving it therefore means feeding the transport handler a
 * `disconnected` message, which is what `dropTransport` does. Asserting through
 * `gatt.disconnect()` instead would have produced a test that passes because
 * NOTHING fires -- green for the wrong reason, and unable to go red.
 */
async function dropTransport(device: any) {
  let onMessage: ((msg: any) => void) | undefined;
  device.transport.onMessage = (cb: (msg: any) => void) => { onMessage = cb; };
  device.isTransportSetup = false;
  device.setupTransportHandler();
  expect(onMessage, 'setupTransportHandler did not register a handler').toBeTypeOf('function');
  onMessage!({ type: 'disconnected' });
}

describe('the device has a removeEventListener at all', () => {
  it('fires a registered disconnect handler -- the control this file needs', async () => {
    const { device } = await connectedServer();
    const handler = vi.fn();
    device.addEventListener('gattserverdisconnected', handler);
    await dropTransport(device);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('removes a disconnect handler it previously added', async () => {
    const { device } = await connectedServer();
    const handler = vi.fn();
    device.addEventListener('gattserverdisconnected', handler);
    device.removeEventListener('gattserverdisconnected', handler);
    await dropTransport(device);
    expect(handler).not.toHaveBeenCalled();
  });

  it('dedups disconnect handlers too', async () => {
    const { device } = await connectedServer();
    const handler = vi.fn();
    device.addEventListener('gattserverdisconnected', handler);
    device.addEventListener('gattserverdisconnected', handler);
    await dropTransport(device);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
