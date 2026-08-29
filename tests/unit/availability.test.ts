import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockBluetooth } from '../../src/mock-bluetooth.js';

/**
 * `getAvailability()` returned a hardcoded `true`.
 *
 * That is a check that can never go red — the same failure class as the reset
 * detector in TRA-1160 and BLE_MCP_LOG_LEVEL in TRA-1173. A client asking the
 * Web Bluetooth API "is a device available?" was told yes while the bridge was
 * not running at all.
 *
 * What it means now is the SPEC question — is a Bluetooth adapter reachable —
 * not "is the reader free". A held reader still answers true, because a held
 * device is not an availability question; connecting then fails loudly with
 * `Device is busy` naming the holder. The two questions get two APIs rather
 * than one overloaded boolean: who-holds-it lives on
 * `navigator.bluetooth.testing.getReaderState()`.
 */

const CONFIG = {
  service: '9800',
  write: '9900',
  notify: '9901',
  sessionId: 'availability-test',
  onMultipleDevices: 'error' as const
};

function mock(serverUrl = 'ws://localhost:25153') {
  return new MockBluetooth(serverUrl, CONFIG);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getAvailability', () => {
  it('is true when the bridge answers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    expect(await mock().getAvailability()).toBe(true);
  });

  it('is FALSE when the bridge is unreachable', async () => {
    // The case the hardcoded `true` could never report. A dead bridge is the
    // single most common reason a run fails, and it used to answer "available".
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(await mock().getAvailability()).toBe(false);
  });

  it('is true when the reader is held by someone else', async () => {
    // Availability is the adapter question. Busy is a connect-time answer, and
    // overloading this boolean with it would tell a consumer asking "does this
    // browser do Bluetooth" that it does not, because a colleague is mid-run.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ held: true, session: 'someone-else' })
      })
    );
    expect(await mock().getAvailability()).toBe(true);
  });

  it('derives an http status URL from the ws server URL', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', f);
    await mock('ws://example.test:9999').getAvailability();
    expect(f.mock.calls[0][0]).toBe('http://example.test:9999/status');
  });

  it('derives https from wss', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', f);
    await mock('wss://secure.test/').getAvailability();
    expect(f.mock.calls[0][0]).toBe('https://secure.test/status');
  });
});

describe('testing.getReaderState', () => {
  it('returns who holds the reader and since when', async () => {
    const body = {
      held: true,
      session: 'ble-mcp-e2e-mssb',
      acquired_at: '2026-08-26T15:42:10Z',
      held_seconds: 91,
      device_name: 'CS108Reader2603A7'
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body }));
    expect(await mock().testing.getReaderState()).toEqual(body);
  });

  it('returns null when the bridge is unreachable', async () => {
    // Distinguishable from "free": null means nobody could be asked, which is a
    // different situation to walk into than a bridge reporting held=false.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(await mock().testing.getReaderState()).toBeNull();
  });
});
