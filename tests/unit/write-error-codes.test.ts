import { describe, it, expect, afterEach } from 'vitest';
import {
  MockBluetooth,
  WriteError,
  WRITE_ERROR_CODES,
  type WriteErrorCode
} from '../../src/index.js';
import { startStubBridge, type StubBridge } from '../conformance/stub-bridge.js';

/**
 * Every write rejection is a typed value, not a sentence.
 *
 * ## What this replaces, and why a test here is the point
 *
 * Until 0.10.0 the ack-timeout rejection was a bare `Error` whose only
 * discriminator was its message text -- and platform's transport matched that
 * text as a substring to decide whether to retry. So an unreferenced string
 * literal in `ws-transport.ts` was load-bearing across two repositories, and
 * **the only guard against rewording it lived in the consumer's repo**, which is
 * the one place a change here cannot go red.
 *
 * These checks exercise the real client path against the stub bridge, so they
 * fail if a code is dropped, renamed, or stops being carried -- in THIS repo, in
 * the PR that does it.
 *
 * ## Why `mayHaveReachedDevice` gets its own check
 *
 * It is the property a retry decision actually turns on, and it is the one thing
 * here a consumer must not re-derive by enumerating codes: an allowlist silently
 * misclassifies the next code added, which is the defect this change removed.
 */
const SERVICE = '0000f00d-0000-1000-8000-00805f9b34fb';
const WRITE = '0000c0de-0000-1000-8000-00805f9b34fb';
const NOTIFY = '0000beef-0000-1000-8000-00805f9b34fb';

let bridge: StubBridge | undefined;
afterEach(async () => { await bridge?.close(); bridge = undefined; });

async function characteristicOn(options: Parameters<typeof startStubBridge>[0] = {}) {
  bridge = await startStubBridge(options);
  const bluetooth = new MockBluetooth(bridge.url, {
    service: SERVICE,
    write: WRITE,
    notify: NOTIFY,
    sessionId: 'write-error-codes',
    timeout: 5000,
    onMultipleDevices: 'error'
  });
  const device: any = await bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
  const server = await device.gatt.connect();
  const service: any = await server.getPrimaryService(SERVICE);
  return { characteristic: await service.getCharacteristic(WRITE), server };
}

/** Fail with the actual error rather than a bare assertion -- a WriteError that
 *  arrived with the wrong code should say which code it had. */
async function writeErrorFrom(promise: Promise<unknown>): Promise<WriteError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof WriteError) return e;
    throw new Error(
      `expected a WriteError, got ${(e as Error)?.name}: ${(e as Error)?.message}`
    );
  }
  throw new Error('expected the write to reject, but it resolved');
}

describe('a write rejection carries a code, so no consumer has to read its prose', () => {
  it('WRITE_REJECTED when the bridge acks ok:false -- it answered, so this is definite', async () => {
    const { characteristic } = await characteristicOn({ failWrites: true });
    const error = await writeErrorFrom(characteristic.writeValue(new Uint8Array([0x01])));
    expect(error.code).toBe(WRITE_ERROR_CODES.WRITE_REJECTED);
    expect(error.name).toBe('WriteError');
  });

  it('ACK_TIMEOUT when no ack arrives -- it did NOT answer, so this is unknown', { timeout: 5000 }, async () => {
    const { characteristic } = await characteristicOn({ withholdAcks: true });
    // Runs against the production 1500ms cap. `writeValue(value)` takes no
    // options because real Web Bluetooth takes none, and inventing one to make
    // this test faster would be a fidelity divergence bought with a second.
    const error = await writeErrorFrom(characteristic.writeValue(new Uint8Array([0x01])));
    expect(error.code).toBe(WRITE_ERROR_CODES.ACK_TIMEOUT);
  });

  it('LINK_LOST when the link drops with the write in flight', async () => {
    const { characteristic } = await characteristicOn({ withholdAcks: true });
    const pending = characteristic.writeValue(new Uint8Array([0x01]));
    bridge!.drop();
    const error = await writeErrorFrom(pending);
    expect(error.code).toBe(WRITE_ERROR_CODES.LINK_LOST);
  });

  it('NOT_CONNECTED when there is no socket -- the frame never left', async () => {
    const { characteristic, server } = await characteristicOn();
    await server.disconnect();
    const error = await writeErrorFrom(characteristic.writeValue(new Uint8Array([0x01])));
    expect(error.code).toBe(WRITE_ERROR_CODES.NOT_CONNECTED);
  });
});

describe('mayHaveReachedDevice is the retry discriminator, and it is exhaustive', () => {
  /**
   * ⚠ Exhaustive ON PURPOSE. Adding a code without deciding whether it may have
   * reached the device is the mistake this table exists to make impossible --
   * a new code with no entry fails here rather than defaulting to something.
   */
  const EXPECTED: Record<WriteErrorCode, boolean> = {
    ACK_TIMEOUT: true,
    WRITE_REJECTED: false,
    LINK_LOST: false,
    NOT_CONNECTED: false
  };

  it('every code declares whether the write may already be at the device', () => {
    const codes = Object.values(WRITE_ERROR_CODES).sort();
    expect(codes).toEqual(Object.keys(EXPECTED).sort());
    for (const code of codes) {
      expect(new WriteError(code, 'x').mayHaveReachedDevice).toBe(EXPECTED[code]);
    }
  });

  it('ACK_TIMEOUT is the only one a consumer must never retry', () => {
    // The clause this encodes: a timed-out write may be sitting in the device,
    // so retrying it is a DUPLICATE COMMAND, not a recovery. If this ever goes
    // red, the change is wrong -- not the test.
    const unsafe = Object.values(WRITE_ERROR_CODES)
      .filter(code => new WriteError(code, 'x').mayHaveReachedDevice);
    expect(unsafe).toEqual([WRITE_ERROR_CODES.ACK_TIMEOUT]);
  });
});
