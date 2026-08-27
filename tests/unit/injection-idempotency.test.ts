import { describe, it, expect, vi, afterEach } from 'vitest';
import { injectWebBluetoothMock, MockBluetooth } from '../../src/mock-bluetooth.js';

/**
 * TRA-1153 item 7: a second injection must not ORPHAN the first mock.
 *
 * `injectWebBluetoothMock` constructed a new MockBluetooth and overwrote the
 * global with no guard. A second call on a page already holding a live connection
 * left the first instance's device, transport and characteristics alive with their
 * listeners attached and their socket open, while `navigator.bluetooth` pointed
 * somewhere else. Nothing told the old transport it had been replaced, so it went
 * on believing it was connected -- the silent-fallback class, succeeding against
 * the wrong object.
 *
 * Resolved as TEAR DOWN, not reuse: reuse makes the orphan unlikely, teardown makes
 * it unreachable, and teardown is the honest behaviour for a caller deliberately
 * re-injecting with different config.
 */

const CONFIG = {
  serverUrl: 'ws://localhost:25153',
  service: '9800',
  write: '9900',
  notify: '9901',
  sessionId: 'idempotency-test',
};

/**
 * Give the module a browser surface, and put back exactly what was there.
 *
 * `vitest.config.ts` sets `singleFork: true`, so every unit file shares one
 * process and one set of globals. A bare `vi.stubGlobal('window', ...)` therefore
 * throws "Cannot redefine property: window" the moment anything earlier in the run
 * has defined it -- which is why this passed alone and failed in the suite.
 *
 * So: reuse the window if there is one, and record what to put back. RESTORE
 * rather than delete, because the next file in this shared process inherits
 * whatever we leave behind.
 */
const restores: Array<() => void> = [];

function stubBrowser() {
  const navigator: any = {};
  const existing = (globalThis as any).window;

  if (existing) {
    const had = Object.prototype.hasOwnProperty.call(existing, 'navigator');
    const previous = existing.navigator;
    existing.navigator = navigator;
    restores.push(() => {
      if (had) existing.navigator = previous;
      else delete existing.navigator;
    });
  } else {
    vi.stubGlobal('window', { navigator });
  }
  return navigator;
}

afterEach(() => {
  while (restores.length) restores.pop()!();
  vi.unstubAllGlobals();
});

describe('a second injection replaces the first without orphaning it', () => {
  it('installs a MockBluetooth on the first call', () => {
    const navigator = stubBrowser();
    injectWebBluetoothMock(CONFIG);
    expect(navigator.bluetooth).toBeInstanceOf(MockBluetooth);
  });

  it('tears the previous instance down before replacing it', async () => {
    const navigator = stubBrowser();
    injectWebBluetoothMock(CONFIG);
    const first = navigator.bluetooth as MockBluetooth;
    const teardown = vi.spyOn(first, 'teardown');

    injectWebBluetoothMock({ ...CONFIG, sessionId: 'idempotency-test-2' });

    expect(teardown).toHaveBeenCalledTimes(1);
    expect(navigator.bluetooth).not.toBe(first);
    expect(navigator.bluetooth).toBeInstanceOf(MockBluetooth);
  });

  it('disconnects the devices the previous instance had minted', async () => {
    const navigator = stubBrowser();
    injectWebBluetoothMock(CONFIG);
    const first = navigator.bluetooth as MockBluetooth;

    const device: any = await first.requestDevice();
    const disconnect = vi.spyOn(device.gatt, 'disconnect').mockResolvedValue(undefined);

    await first.teardown();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('completes the replacement even if teardown throws', async () => {
    const navigator = stubBrowser();
    injectWebBluetoothMock(CONFIG);
    const first = navigator.bluetooth as MockBluetooth;
    const device: any = await first.requestDevice();
    vi.spyOn(device.gatt, 'disconnect').mockRejectedValue(new Error('socket already gone'));

    // A teardown that took the injection down with it would leave BOTH the old
    // instance live AND the new one uninstalled -- worse than the leak it prevents.
    expect(() => injectWebBluetoothMock({ ...CONFIG, sessionId: 'after-throw' })).not.toThrow();
    expect(navigator.bluetooth).not.toBe(first);
  });

  it('teardown is idempotent -- a second call disconnects nothing again', async () => {
    const navigator = stubBrowser();
    injectWebBluetoothMock(CONFIG);
    const mock = navigator.bluetooth as MockBluetooth;
    const device: any = await mock.requestDevice();
    const disconnect = vi.spyOn(device.gatt, 'disconnect').mockResolvedValue(undefined);

    await mock.teardown();
    await mock.teardown();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
