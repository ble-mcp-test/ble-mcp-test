import { WriteError, WRITE_ERROR_CODES } from './constants.js';
import { VERSION } from './version.js';

export interface WSMessage {
  // Wire types are exactly what the Python bridge emits: see SERVER_MESSAGE_TYPES
  // in bridge/src/ble_bridge/ws/protocol.py, checked mechanically by
  // test_wire_types_have_a_typescript_consumer. `disconnected` is the one
  // exception -- it never crosses the wire, it is synthesised below in onclose.
  type: 'connected' | 'data' | 'error' | 'warning' | 'disconnected' | 'write_ack';
  seq?: number;
  data?: number[];
  device?: string;
  error?: string;
  warning?: string;
  /** `write_ack` only. See §8 of the WS protocol spec. */
  ok?: boolean;
  /** `write_ack` only: the GATT mode the bridge actually used for THAT write. */
  mode?: 'with-response' | 'without-response';
  /** Echoed verbatim from the `data` frame that caused this ack. Absent when the client sent none. */
  write_id?: string;
  /**
   * `connected` only: the write characteristic's own account of what it
   * supports, e.g. `['write']`. ABSENT when the bridge cannot report it -- which
   * is different from an empty list, and the two call for different behaviour:
   * absent means do not gate, empty would mean gate on nothing.
   */
  write_properties?: string[];
}

/** What a write's acknowledgement tells the caller. */
export interface WriteAck {
  ok: boolean;
  mode: 'with-response' | 'without-response';
  error?: string;
}

export class WebSocketTransport {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private messageHandler?: (msg: WSMessage) => void;
  private sessionId?: string; // v0.4.5: Session management
  
  /**
   * No default URL. `injectWebBluetoothMock` already refuses to run without an
   * explicit `serverUrl`, so the old `= 'ws://localhost:8080'` was unreachable [tra-1186-historical]
   * through the supported entry point -- a dead value that read like a live
   * guess, and pointed at the port the bridge no longer uses.
   */
  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }
  
  async connect(options?: { 
    device?: string; 
    service?: string; 
    write?: string; 
    notify?: string;
    session?: string;
  }): Promise<void> {
    const url = new URL(this.serverUrl);
    if (options?.device) url.searchParams.set('device', options.device);
    if (options?.service) url.searchParams.set('service', options.service);
    if (options?.write) url.searchParams.set('write', options.write);
    if (options?.notify) url.searchParams.set('notify', options.notify);
    
    // Session management
    if (options?.session) {
      url.searchParams.set('session', options.session);
      this.sessionId = options.session;
    }
    
    // Version marker. Undocumented on the wire on purpose: it is how the bridge
    // tells a client that went through this transport from one that did not.
    //
    // ONE source, statically imported. This used to branch on
    // `typeof __PACKAGE_VERSION__` -- an esbuild define present only in the
    // browser bundle -- and fall back to `await import('./package-metadata.js')`,
    // which does a synchronous readFileSync of package.json. So the value of
    // `_mv` depended on how the package had been built, and every entry point
    // that was imported rather than bundled reached the filesystem from inside
    // connect(). That is what made a plain ESM entry point unusable in a browser.
    url.searchParams.set('_mv', VERSION);
    
    this.ws = new WebSocket(url.toString());
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);
      
      this.ws!.onopen = () => {
        // WebSocket opened, wait for connected message
      };
      
      this.ws!.onmessage = (event) => {
        try {
          const msg: WSMessage = JSON.parse(event.data);
          if (msg.type === 'warning') {
            // Interstitial, NOT terminal: the server sends this before `connected`
            // (bridge .../ws/server.py, _take_over) to say this client displaced
            // somebody. Log it and keep waiting — settling here would end the
            // handshake on a non-terminal frame.
            console.warn(`[Transport] Server warning: ${msg.warning}`);
          } else if (msg.type === 'connected') {
            clearTimeout(timeout);
            // Kept off the resolve value so `connect()` keeps its void contract.
            // Absent stays undefined -- see the field's note: a bridge that
            // cannot report properties must not read as a device with none.
            this.writeProperties = msg.write_properties;
            resolve();
          } else if (msg.type === 'error') {
            clearTimeout(timeout);
            reject(new Error(msg.error || 'Connection failed'));
          }
        } catch {
          // Ignore invalid messages
        }
      };
      
      this.ws!.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket error'));
      };
      
      this.ws!.onclose = (event: CloseEvent) => {
        this.ws = null;

        // Writes still awaiting an ack can never get one now. Failing them here
        // is what makes LINK_LOST reachable at all: without it they run out the
        // full ack cap and surface as ACK_TIMEOUT, whose whole meaning is "the
        // write MAY have reached the device" -- so a consumer correctly refuses
        // to retry a write that definitively never left. Wrong answer, arrived
        // at slowly, which is the worst combination.
        this.failPendingWrites(
          `the connection closed with code ${event.code} while this write was in flight`
        );
        
        // Handle application-specific close codes (4000-4999) during connection
        if (event.code >= 4000 && event.code <= 4999) {
          clearTimeout(timeout);
          
          // There used to be a CLOSE_CODE_MESSAGES[event.code] lookup here,
          // mapping 4001-4006 to friendlier text. Those codes are TypeScript-
          // bridge-era: `grep` for them across `bridge/` returns ZERO, so the
          // Python bridge has never closed with one and the lookup could only
          // ever miss. Deleted in 0.10.0 along with the table -- see the note in
          // constants.ts. This branch keeps the generic range check, which any
          // 4xxx close does satisfy.
          const reason = event.reason || 'Hardware connection failed';
          
          console.error(`[WebSocketTransport] Connection failed with code ${event.code}: ${reason}`);
          
          // Create error with close code for upstream handling
          const error = new Error(`Connection failed: ${reason}`) as Error & { code: number };
          error.code = event.code;
          
          reject(error);
          return;
        }
        
        // Handle other close events (after successful connection)
        if (this.messageHandler) {
          this.messageHandler({ 
            type: 'disconnected',
            error: event.code !== 1000 ? `Connection closed with code ${event.code}: ${event.reason}` : undefined
          });
        }
      };
    });
  }
  
  send(data: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }
    this.ws.send(JSON.stringify({
      type: 'data',
      data: Array.from(data)
    }));
  }

  /**
   * Writes still pending an ack, keyed by the `write_id` we minted for them.
   *
   * The bridge's relay is serial, but this is keyed rather than a queue because
   * positional correlation is exactly what §8 of the protocol spec rejected: a
   * dropped or out-of-order ack would silently shift every subsequent write onto
   * the wrong promise, and nothing would look wrong.
   */
  private pendingWrites = new Map<string, {
    resolve: (ack: WriteAck) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private writeSeq = 0;

  /**
   * What the peripheral says its write characteristic supports, from the
   * `connected` frame. `undefined` when the bridge did not report it.
   *
   * The mock gates `writeValueWithoutResponse()` on this, because real Chrome
   * rejects that call on a characteristic lacking the property. Until this was
   * on the wire the mock could not perform that check, which made it LOOSER than
   * the API it doubles -- a call passing here and throwing in the browser.
   */
  writeProperties?: string[];

  /**
   * Send a write and resolve when the bridge acknowledges THAT write.
   *
   * Resolves with the ack -- including `mode`, which the caller needs because
   * `ok: true` means different things under the two GATT modes: a peer ATT
   * confirmation under with-response, and merely "handed to the proxy" under
   * without-response. The mode is a runtime knob on the bridge, so it cannot be
   * inferred from configuration and has to be read off each ack.
   *
   * REJECTS on `ok: false` and on timeout. It does not resolve-with-failure,
   * because every caller of this is a `writeValue()` whose Web Bluetooth
   * contract is to reject when the write did not happen.
   *
   * ## Why the default is 1500ms, and why it is not a preference
   *
   * There are three timeouts stacked on this path, and the innermost has to fire
   * first:
   *
   *     this ack timeout            1500ms   <- innermost, fires first
   *     platform WRITE_BUDGET_MS    2000ms
   *     platform CommandManager     2500ms
   *
   * It was 5000ms, which put it OUTSIDE both. A hung write then blew the
   * consumer's write budget at 2000, its command rejected at 2500, and this
   * promise finally rejected at 5000 -- into a caller that had stopped existing
   * 2.5 seconds earlier. That does not merely lose the retry; it MANUFACTURES
   * ORPHANED REJECTIONS, which is the same shape as the 1389 `Command timeout`
   * entries in the 2026-08-27 soak: work completing for a caller that is already
   * gone, reported as a timeout that names nothing useful.
   *
   * At 1500 a failed write surfaces inside the consumer's budget, so their retry
   * path is reachable for hung writes and not only for fast failures. Raising it
   * again means raising their budget past their command timeout, which #583
   * deliberately sized it under -- so this is the end that moves.
   */
  sendAwaitingAck(data: Uint8Array, timeoutMs = 1500): Promise<WriteAck> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new WriteError(
        WRITE_ERROR_CODES.NOT_CONNECTED,
        'not connected: the frame was not sent'
      ));
    }
    const writeId = `w-${++this.writeSeq}`;

    return new Promise<WriteAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWrites.delete(writeId);
        // Named as a missing acknowledgement rather than a generic timeout: the
        // write may well have reached the device, and a caller retrying blindly
        // on this needs to know it might be sending twice.
        //
        // ⚠ That warning used to live ONLY in this sentence, which made the
        // sentence load-bearing across repositories. It is now carried by
        // `mayHaveReachedDevice` on the error, and THAT is what a consumer reads
        // to decide about retrying. The text below is free to be reworded.
        reject(new WriteError(
          WRITE_ERROR_CODES.ACK_TIMEOUT,
          `write ${writeId} was not acknowledged within ${timeoutMs}ms; ` +
          'the write may or may not have reached the device'
        ));
      }, timeoutMs);

      this.pendingWrites.set(writeId, { resolve, reject, timer });

      try {
        this.ws!.send(JSON.stringify({ type: 'data', data: Array.from(data), write_id: writeId }));
      } catch (e) {
        clearTimeout(timer);
        this.pendingWrites.delete(writeId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * Settle the write an ack names. Returns whether it was consumed, so the
   * caller can decide about forwarding.
   */
  private settleWriteAck(msg: WSMessage): boolean {
    if (msg.type !== 'write_ack' || !msg.write_id) return false;
    const pending = this.pendingWrites.get(msg.write_id);
    if (!pending) return false;   // an ack for a write we already timed out
    this.pendingWrites.delete(msg.write_id);
    clearTimeout(pending.timer);

    const mode = msg.mode ?? 'with-response';
    if (msg.ok) {
      pending.resolve({ ok: true, mode });
    } else {
      // Distinct from ACK_TIMEOUT on purpose: the bridge answered, so this is a
      // definite non-delivery rather than an unknown one. It is the only write
      // failure a consumer can retry without risking a duplicate command.
      pending.reject(new WriteError(
        WRITE_ERROR_CODES.WRITE_REJECTED,
        msg.error ?? 'the bridge reported the write failed'
      ));
    }
    return true;
  }

  /**
   * Fail every in-flight write. Called when the link goes away: a write awaiting
   * an ack that can no longer arrive would otherwise hang until its own timeout,
   * which presents as slowness rather than as the disconnection it is.
   */
  private failPendingWrites(reason: string): void {
    for (const [, pending] of this.pendingWrites) {
      clearTimeout(pending.timer);
      pending.reject(new WriteError(WRITE_ERROR_CODES.LINK_LOST, reason));
    }
    this.pendingWrites.clear();
  }
  
  onMessage(callback: (msg: WSMessage) => void): void {
    this.messageHandler = callback;
    if (this.ws) {
      this.ws.onmessage = (event) => {
        try {
          const msg: WSMessage = JSON.parse(event.data);
          // Settle first, then forward. A write_ack is a transport concern, but
          // it is still forwarded so nothing downstream is surprised by a wire
          // message it cannot see -- the handlers are if/else chains with no
          // throwing default, so an unrecognised type is ignored.
          this.settleWriteAck(msg);
          if (this.messageHandler) {
            this.messageHandler(msg);
          }
        } catch {
          // Ignore invalid messages
        }
      };
    }
  }
  
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    // A local disconnect is still a link loss for anything in flight, and
    // `close()` does not fire onclose synchronously.
    this.failPendingWrites('the transport was disconnected while this write was in flight');
  }
  
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
  
  // Session management methods
  getSessionId(): string | undefined {
    return this.sessionId;
  }
  
  async reconnectToSession(sessionId: string): Promise<void> {
    return this.connect({ session: sessionId });
  }
}