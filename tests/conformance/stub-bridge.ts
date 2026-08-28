/**
 * An in-process WebSocket server that speaks just enough of the bridge protocol
 * for a client to complete a real connect.
 *
 * ⚠ SCOPE, AND IT IS NARROW. This proves the CLIENT SURFACE. It proves NOTHING
 * about the wire: no roles, no takeover, no release timing, no error frames, no
 * `Device is busy`, no close codes. It answers one canned `connected` and echoes
 * what it is given.
 *
 * That caveat is repeated in what the conformance run PRINTS, not only here,
 * because a caveat in a file header is one nobody reads at the moment they need
 * it -- the "N/N PASS" line travels and the header does not. Release timing is
 * the most dangerous silence in particular: it is the exact property four e2e
 * specs encoded wrong for months with nothing to contradict them.
 *
 * What it is FOR: replacing the `device.gatt.connected = true` reach-in that four
 * unit files used. Setting that flag skips connect() entirely, which is fine for
 * asserting lifecycle behaviour against the mock and impossible against real
 * `navigator.bluetooth` -- so any suite built on it can never be a fidelity
 * suite, no matter what it asserts. Arm A does a real connect against this.
 *
 * `ws` is used here and only here in the test tree. When TRA-1187 item 4 deleted
 * `src/node/` -- its only runtime importer -- this file is why `ws` moved to
 * devDependencies rather than disappearing. The package now ships with no
 * runtime dependencies at all.
 */
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { AddressInfo } from 'net';

export interface StubBridgeConnection {
  /** Every query parameter the client put on its connect URL, `_mv` included. */
  readonly params: URLSearchParams;
  /** Every `data` payload the client has written, in order. */
  readonly writes: number[][];
}

export interface StubBridge {
  /** `ws://127.0.0.1:<port>` -- pass this to the mock as its serverUrl. */
  readonly url: string;
  /** Connections in the order they were accepted. */
  readonly connections: StubBridgeConnection[];
  /** The most recent connection, or undefined before the first. */
  readonly latest: StubBridgeConnection | undefined;
  /** Push a notification frame to the most recent client, as the bridge would. */
  notify(data: number[] | Uint8Array): void;
  /** Drop the most recent client's socket, as a device disconnect would. */
  drop(): void;
  close(): Promise<void>;
}

export interface StubBridgeOptions {
  /**
   * Echo every write straight back as a `data` frame. Off by default: a bridge
   * does not echo, and a suite that assumed it did would be asserting against
   * its own double rather than against anything a device does.
   */
  echoWrites?: boolean;
}

export async function startStubBridge(options: StubBridgeOptions = {}): Promise<StubBridge> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const connections: StubBridgeConnection[] = [];
  const sockets: WsSocket[] = [];

  wss.on('connection', (socket, request) => {
    const params = new URL(request.url ?? '/', 'ws://127.0.0.1').searchParams;
    const record: StubBridgeConnection = { params, writes: [] };
    connections.push(record);
    sockets.push(socket);

    socket.on('message', raw => {
      let message: { type?: string; data?: number[] };
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === 'data' && Array.isArray(message.data)) {
        record.writes.push(message.data);
        if (options.echoWrites) {
          socket.send(JSON.stringify({ type: 'data', data: message.data }));
        }
      }
    });

    // The handshake frame the transport waits for. Anything else -- including
    // silence -- and connect() fails on its 10s timeout instead.
    socket.send(JSON.stringify({ type: 'connected', device: 'stub-bridge' }));
  });

  await new Promise<void>(resolve => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;

  const latestSocket = (): WsSocket => {
    const socket = sockets[sockets.length - 1];
    if (!socket) throw new Error('stub bridge: no client has connected yet');
    return socket;
  };

  return {
    url: `ws://127.0.0.1:${port}`,
    connections,
    get latest() {
      return connections[connections.length - 1];
    },
    notify(data) {
      latestSocket().send(JSON.stringify({ type: 'data', data: Array.from(data) }));
    },
    drop() {
      latestSocket().close();
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        wss.close(error => (error ? reject(error) : resolve()))
      );
    }
  };
}

/**
 * The scope caveat, in the form that travels. Printed by the conformance run.
 *
 * Kept beside the stub rather than beside the reporter so it cannot drift from
 * what the stub actually models.
 */
export const STUB_BRIDGE_CAVEAT =
  'arm A runs against an in-process stub bridge: it proves the client surface ' +
  'and NOTHING about the wire -- no roles, no takeover, no release timing, no ' +
  'error frames.';
