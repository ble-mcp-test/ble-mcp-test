import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { BridgeServer } from '../../src/bridge-server.js';
import type { BleTransport } from '../../src/ble-transport.js';
import type { BleConfig } from '../../src/noble-transport.js';

class StubTransport extends EventEmitter implements BleTransport {
  connected = false;
  readonly writes: Uint8Array[] = [];
  constructor(public readonly config: BleConfig) { super(); }
  async connect() { this.connected = true; return { name: 'StubDevice', id: 'stub' }; }
  async write(data: Uint8Array) { this.writes.push(data); }
  async cleanup() { this.connected = false; }
  isConnected() { return this.connected; }
}

let server: BridgeServer | null = null;

afterEach(async () => {
  if (server) { await server.stop(); server = null; }
});

describe('transport seam', () => {
  it('uses the injected factory instead of NobleTransport, and never touches a radio', async () => {
    const built: StubTransport[] = [];
    server = new BridgeServer(undefined, undefined, (cfg) => {
      const t = new StubTransport(cfg);
      built.push(t);
      return t;
    });

    const port = await server.start(0, '127.0.0.1');
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(8080);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/?service=9800&write=9900&notify=9901`);
    const connected = await new Promise<any>((resolve, reject) => {
      ws.on('message', (raw) => resolve(JSON.parse(raw.toString())));
      ws.on('error', reject);
    });

    expect(connected).toEqual({ type: 'connected', device: 'StubDevice' });
    expect(built).toHaveLength(1);
    expect(built[0].config.service).toBe('9800');
    expect(built[0].isConnected()).toBe(true);

    ws.close();
  });

  it('forwards transport data events to the WebSocket as `data` frames', async () => {
    let transport: StubTransport | null = null;
    server = new BridgeServer(undefined, undefined, (cfg) => {
      transport = new StubTransport(cfg);
      return transport;
    });
    const port = await server.start(0, '127.0.0.1');

    const ws = new WebSocket(`ws://127.0.0.1:${port}/?service=9800&write=9900&notify=9901`);
    const frames: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        frames.push(msg);
        if (msg.type === 'connected') resolve();
      });
      ws.on('error', reject);
    });

    transport!.emit('data', new Uint8Array([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 50));

    expect(frames).toContainEqual({ type: 'data', data: [1, 2, 3] });
    ws.close();
  });
});
