import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocketTransport } from '../../src/ws-transport.js';

/**
 * The takeover warning is sent mid-handshake, immediately BEFORE `connected`
 * (bridge/src/ble_bridge/ws/server.py, _take_over). Its whole purpose is to tell
 * a client it just displaced somebody else's session.
 *
 * Before TRA-1162 the handshake handler branched on `connected` and `error` only
 * and dropped everything else silently, so that announcement reached the browser
 * and vanished. _take_over's docstring asserted "the client logs it and keeps
 * waiting" — the second half was true, the first half was not.
 *
 * `warning` must be interstitial: logged, and the handshake keeps waiting. A port
 * that treated it as terminal would settle the promise on a non-terminal frame.
 */
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  readyState = 1;
  sent: string[] = [];
  constructor(public url: string) { FakeWebSocket.last = this; }
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = 3; }
  deliver(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

const orig = globalThis.WebSocket;
afterEach(() => { (globalThis as never as { WebSocket: unknown }).WebSocket = orig; vi.restoreAllMocks(); });

describe('handshake warning', () => {
  it('logs a mid-handshake warning and keeps waiting for connected', async () => {
    (globalThis as never as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const transport = new WebSocketTransport('ws://localhost:15104');
    const connecting = transport.connect({ service: '9800', write: '9900', notify: '9901' });
    await vi.waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
    const ws = FakeWebSocket.last!;

    ws.deliver({ type: 'warning', warning: 'took the command path over from session "abc"' });

    // Interstitial: the warning must NOT settle the handshake.
    let settled = false;
    void connecting.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled, 'a warning must not settle the handshake').toBe(false);

    // And it must have surfaced, not been dropped on the floor.
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('took the command path over')),
      'the takeover warning never reached the console',
    ).toBe(true);

    ws.deliver({ type: 'connected', device: 'CS108Reader' });
    await expect(connecting).resolves.toBeUndefined();
  });
});
