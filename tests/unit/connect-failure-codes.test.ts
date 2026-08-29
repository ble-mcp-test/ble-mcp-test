import { describe, it, expect, afterEach } from 'vitest';
import { MockBluetooth, ConnectError, CONNECT_ERROR_CODES } from '../../src/index.js';
import { startStubBridge, type StubBridge } from '../conformance/stub-bridge.js';

/**
 * A failed connect fails, rather than hanging until the connect timeout.
 *
 * ## What this replaces
 *
 * `connect()`'s `onclose` rejected the handshake ONLY on close codes 4000-4999,
 * and the Python bridge has never sent one -- zero occurrences in `bridge/`. So
 * every real connect-time close (bridge down, refused, killed mid-handshake)
 * fell past that branch and the caller waited out the full **10 second** connect
 * timeout instead of failing.
 *
 * A dead bridge presented as ten seconds of nothing rather than as a connection
 * failure. It sat directly on the path a 17h connect soak was about to
 * characterise, so the run would have measured the bug's wall-clock, not the
 * radio's -- and the instrument built to explain the resulting cluster would
 * have made the defect survivable instead of visible.
 */
const SERVICE = '0000f00d-0000-1000-8000-00805f9b34fb';

let bridge: StubBridge | undefined;
afterEach(async () => { await bridge?.close(); bridge = undefined; });

async function connectTo(options: Parameters<typeof startStubBridge>[0]) {
  bridge = await startStubBridge(options);
  const bluetooth = new MockBluetooth(bridge.url, {
    service: SERVICE,
    write: '0000c0de-0000-1000-8000-00805f9b34fb',
    notify: '0000beef-0000-1000-8000-00805f9b34fb',
    sessionId: 'connect-failure-codes',
    onMultipleDevices: 'error'
  });
  const device: any = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
  return device.gatt.connect();
}

describe('a close before `connected` fails the handshake immediately', () => {
  it('rejects with CLOSED_BEFORE_CONNECTED, not after the 10s connect timeout', async () => {
    const started = Date.now();
    let error: any;
    try {
      await connectTo({ closeBeforeConnected: true });
    } catch (e) {
      error = e;
    }
    const elapsed = Date.now() - started;

    expect(error).toBeInstanceOf(ConnectError);
    expect(error.code).toBe(CONNECT_ERROR_CODES.CLOSED_BEFORE_CONNECTED);
    // The point of the fix. 10000ms is the connect timeout it used to wait out;
    // anything near it means the close is falling through again.
    expect(elapsed).toBeLessThan(2000);
  }, 15000);

  it('the stub closes with 1000, so this cannot pass via the old 4xxx branch', async () => {
    // Guards the guard: if someone reintroduces the `code >= 4000` gate, an
    // ordinary close must still fail fast. A 4xxx-only test would go green
    // against the broken code.
    let error: any;
    try {
      await connectTo({ closeBeforeConnected: true });
    } catch (e) {
      error = e;
    }
    expect(error.message).toMatch(/1000|closed/i);
  }, 15000);
});
