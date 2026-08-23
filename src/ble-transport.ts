import type { EventEmitter } from 'events';
import type { BleConfig } from './noble-transport.js';

/**
 * The transport surface BleSession actually uses.
 *
 * NobleTransport satisfies this structurally. Declaring it separately gives the
 * bridge a single injection point: a harness can drive the relay at rate with no
 * radio and no reader present (see tests/stress/firehose-transport.ts), and the
 * Python rewrite has an explicit contract to reproduce.
 *
 * Events: 'data' (Uint8Array), 'disconnect' ().
 */
export interface BleTransport extends EventEmitter {
  connect(): Promise<{ name: string; id: string }>;
  write(data: Uint8Array): Promise<void>;
  cleanup(): Promise<void>;
  isConnected(): boolean;
}

/** Builds a transport for one session. Defaults to NobleTransport everywhere in production. */
export type TransportFactory = (config: BleConfig) => BleTransport;
