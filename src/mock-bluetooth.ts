/**
 * Mock Web Bluetooth API
 * 
 * Provides a mock implementation of the Web Bluetooth API that routes
 * all calls through the WebSocketTransport, bypassing all native dialogs
 * 
 * ====================================================================
 * 🤖 AI DEBUGGING TIP: Using MCP for Enhanced Debugging
 * ====================================================================
 * 
 * If you're an AI agent debugging an application that uses this mock,
 * the ble-mcp-test server provides powerful MCP (Model Context Protocol)
 * tools for real-time debugging:
 * 
 * Available MCP Tools:
 * - get_logs: View recent BLE communication with filtering
 * - search_packets: Find specific hex patterns in traffic
 * - get_connection_state: Check current BLE connection status
 * - status: Get server configuration and health
 * - scan_devices: Discover nearby BLE devices
 * 
 * Health Check:
 * - HTTP endpoint: http://localhost:8081/health
 * - Returns: { status: 'ok', timestamp: string, bridge: {...} }
 * - Use before running tests to ensure server is available
 * 
 * Example Usage:
 * 1. Use get_logs to see recent TX/RX packets
 * 2. Use search_packets to find specific command/response patterns
 * 3. Monitor connection state during debugging
 * 
 * The server runs MCP by default on stdio. For network access:
 * - Run with --mcp-http for HTTP transport on port 8081
 * - Or set MCP_TOKEN=secret for authenticated access
 * 
 * This enables real-time inspection of BLE communication without
 * modifying application code or adding console.log statements.
 * ====================================================================
 */

import { WebSocketTransport } from './ws-transport.js';

// Testing API interfaces
export interface TestCommandOptions {
  device: any; // BluetoothDevice in browser context
  writeCharacteristic: any; // BluetoothRemoteGATTCharacteristic in browser context
  notifyCharacteristic: any; // BluetoothRemoteGATTCharacteristic in browser context
  command: Uint8Array;
  timeout?: number;
  validateResponse?: (data: Uint8Array) => boolean;
}

export interface TestResult {
  success: boolean;
  response?: Uint8Array;
  responseHex?: string;
  error?: string;
  timeout?: boolean;
}

export interface SimulateNotificationOptions {
  characteristic: any; // BluetoothRemoteGATTCharacteristic in browser context
  data: Uint8Array;
  delay?: number;
}

export interface TestingUtils {
  toHex(data: Uint8Array): string;
  fromHex(hex: string): Uint8Array;
  equals(a: Uint8Array, b: Uint8Array): boolean;
}

export interface BluetoothTesting {
  testCommand(options: TestCommandOptions): Promise<TestResult>;
  simulateNotification(options: SimulateNotificationOptions): Promise<void>;
  /**
   * Who holds the reader, and since when. `null` when the bridge cannot be
   * reached -- which is a different situation to walk into than a bridge
   * reporting `held: false`, so the two are not collapsed.
   *
   * This is the non-spec half of the availability question.
   * `getAvailability()` answers "is an adapter reachable"; this answers
   * "is someone driving it, who, and for how long".
   */
  getReaderState(): Promise<ReaderState | null>;
  /**
   * Force what `getAvailability()` reports, or `null` to go back to asking.
   *
   * TRA-35's original request: exercise the no-adapter path without unplugging
   * anything. It lands *after* the real reading deliberately -- a knob that
   * forces `false` is only meaningful once `true` means something, and building
   * it first would have produced another constant wearing a different value.
   *
   * Per mock instance, off unless set, and clearable back to the real reading
   * rather than to the opposite constant. Those three are what keep it from
   * becoming the hardcoded `true` this method used to be.
   */
  setAvailability(value: boolean | null): void;
  utils: TestingUtils;
}

/** The bridge's GET /status payload. */
export interface ReaderState {
  held: boolean;
  session: string | null;
  acquired_at: string | null;
  held_seconds: number | null;
  ready: boolean;
  device_name: string | null;
  device_id: string | null;
  observer_count: number;
  version: string;
}

/**
 * Mock BluetoothRemoteGATTCharacteristic.
 *
 * `dispatchEvent` is the public notification surface, matching the real Web
 * Bluetooth API; `triggerNotification` is private and stays that way. Anything
 * injecting a notification — `navigator.bluetooth.testing.simulateNotification`
 * included — goes through `dispatchEvent`.
 *
 * Exported so tests can construct a real instance. Assertions against a
 * hand-rolled stub pass whether or not this class works.
 */
export class MockBluetoothRemoteGATTCharacteristic {
  private notificationHandlers: Array<{ handler: (event: any) => void; once: boolean }> = [];

  constructor(
    private service: MockBluetoothRemoteGATTService,
    public uuid: string
  ) {
    // Register this characteristic with the device for transport message handling
    this.service.server.device.registerCharacteristic(this.uuid, this);
  }

  async writeValue(value: BufferSource): Promise<void> {
    const data = new Uint8Array(value as ArrayBuffer);
    // Fire-and-forget - send returns void, no await needed
    this.service.server.device.transport.send(data);
    // Return immediately since BLE commands are fire-and-forget
    // Responses come through notifications
  }

  /**
   * Whether this characteristic is subscribed. A real one delivers nothing until
   * it is, and the mock used to deliver regardless -- which let a consumer forget
   * to subscribe and still pass here, then receive nothing on a real radio.
   */
  private subscribed = false;

  /** Public, because the testing API has to refuse a notification nobody subscribed to. */
  get isSubscribed(): boolean {
    return this.subscribed;
  }

  async startNotifications(): Promise<MockBluetoothRemoteGATTCharacteristic> {
    this.subscribed = true;
    return this;
  }

  async stopNotifications(): Promise<MockBluetoothRemoteGATTCharacteristic> {
    if (!this.subscribed) {
      // Rejecting with the situation NAMED, not a bare throw. platform wraps
      // this call in a catch that is dead today because the method is a no-op;
      // making it a real gate makes that catch reachable, and "already stopped"
      // versus "transport gone" is a different debugging session for whoever
      // eventually unwraps it.
      throw new Error(
        `Characteristic ${this.uuid} is not subscribed: stopNotifications() ` +
          'was called without a preceding startNotifications().'
      );
    }
    this.subscribed = false;
    return this;
  }

  addEventListener(event: string, handler: any, options?: AddEventListenerOptions): void {
    if (event !== 'characteristicvaluechanged') return;
    const once = readListenerOptions(options);
    // The DOM drops a duplicate (type, listener, capture) silently; a bare push
    // does not. That difference is invisible until something re-registers the
    // SAME bound handler on the SAME instance -- which a reconnect does, because
    // the consumer binds once in its constructor and re-runs its connect chain.
    // Every notification would then be delivered twice, presenting as duplicated
    // device frames, i.e. as a reader or bridge fault rather than a listener bug.
    if (this.notificationHandlers.some(entry => entry.handler === handler)) return;
    this.notificationHandlers.push({ handler, once });
  }
  
  removeEventListener(event: string, handler: any): void {
    if (event === 'characteristicvaluechanged') {
      const index = this.notificationHandlers.findIndex(entry => entry.handler === handler);
      if (index > -1) {
        this.notificationHandlers.splice(index, 1);
      }
    }
  }

  dispatchEvent(event: Event): boolean {
    if (event.type === 'characteristicvaluechanged') {
      // Extract data from the event structure created by simulateNotification
      const target = (event as any).target;
      if (target && target.value) {
        // Convert DataView to Uint8Array
        const dataView = target.value as DataView;
        const data = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
        
        // Use existing notification mechanism
        this.triggerNotification(data);
      }
    }
    return true; // Event was dispatched
  }

  // Called by the device when transport receives data
  handleTransportMessage(data: Uint8Array): void {
    // The gate belongs here, not on the handler list. An unsubscribed
    // characteristic with listeners attached is exactly the case a real radio
    // delivers nothing to, and the case this mock used to deliver to anyway.
    if (!this.subscribed) return;
    if (this.notificationHandlers.length > 0) {
      this.triggerNotification(data);
    }
  }

  private triggerNotification(data: Uint8Array): void {
    // A real DataView, not a duck-typed stand-in. The old shape carried
    // buffer/byteLength/byteOffset/getUint8 and satisfied any structural check
    // while failing anything that called a method it had not thought to fake --
    // getUint16, getFloat32, or an `instanceof` test.
    //
    // The three-arg form is load-bearing: `new DataView(data.buffer)` alone
    // would expose the whole backing buffer, so a subarray payload would deliver
    // bytes the sender never sent.
    const mockEvent = {
      target: {
        value: new DataView(data.buffer, data.byteOffset, data.byteLength)
      }
    };
    
    // Snapshot first: a `once` handler removes itself, and a handler is allowed
    // to add or remove others. Iterating the live array would skip or repeat.
    const entries = [...this.notificationHandlers];
    for (const entry of entries) {
      if (entry.once) {
        const index = this.notificationHandlers.indexOf(entry);
        if (index > -1) this.notificationHandlers.splice(index, 1);
      }
      entry.handler(mockEvent);
    }
  }
}

// Mock BluetoothRemoteGATTService
class MockBluetoothRemoteGATTService {
  /**
   * One characteristic instance per UUID, for the lifetime of this service.
   *
   * A real `getCharacteristic` returns the same object for the same UUID, and
   * the mock used to mint a new one per call. That was not merely wasteful: the
   * device's `characteristics` Map is a fan-out registry keyed by UUID, so the
   * second instance EVICTED the first from it. The first reference kept its
   * event listeners and silently stopped receiving frames -- no error, nowhere.
   *
   * Caching here fixes both at once: identity matches the real API, and there is
   * only ever one registration to evict.
   */
  private characteristics = new Map<string, MockBluetoothRemoteGATTCharacteristic>();

  constructor(
    public server: MockBluetoothRemoteGATTServer,
    public uuid: string
  ) {}

  async getCharacteristic(characteristicUuid: string): Promise<MockBluetoothRemoteGATTCharacteristic> {
    const existing = this.characteristics.get(characteristicUuid);
    if (existing) return existing;
    const characteristic = new MockBluetoothRemoteGATTCharacteristic(this, characteristicUuid);
    this.characteristics.set(characteristicUuid, characteristic);
    return characteristic;
  }
}

/**
 * Read `addEventListener` options, honouring what we implement and REFUSING the rest.
 *
 * The mock previously took no options argument at all, so `{ once: true }` was
 * accepted by TypeScript's structural check and then silently dropped -- the
 * listener stayed registered for every subsequent notification. Its own
 * `testing.sendCommandWithResponse` passed exactly that and had been relying on a
 * guarantee it never got.
 *
 * Throwing rather than ignoring is deliberate: a dropped option produces correct-
 * looking behaviour that is wrong only later and elsewhere, which is the most
 * expensive failure class in this codebase. A throw is a control that can go red.
 */
function readListenerOptions(options?: AddEventListenerOptions | boolean): boolean {
  if (options === undefined || options === false) return false;
  if (options === true) {
    throw new Error(
      'addEventListener: the capture flag is not implemented by this mock. ' +
      'Refusing rather than ignoring it -- there is no capture phase here, so a ' +
      'listener registered with one would never behave as the caller expects.'
    );
  }
  const { once, ...rest } = options;
  const unsupported = Object.keys(rest).filter(k => (rest as any)[k] !== undefined && (rest as any)[k] !== false);
  if (unsupported.length > 0) {
    throw new Error(
      `addEventListener: ${unsupported.join(', ')} ${unsupported.length === 1 ? 'is' : 'are'} not ` +
      'implemented by this mock. Refusing rather than ignoring -- silently dropping ' +
      'an option is indistinguishable from honouring it until it matters.'
    );
  }
  return once === true;
}

export interface MockConfig {
  /** Delay before the first connect retry, in ms. */
  connectRetryDelay: number;
  /** How many times connect() retries a bridge-busy refusal. */
  maxConnectRetries: number;
  /**
   * How long disconnect() waits after the socket closes, in ms.
   *
   * MEASURED, not inherited. 997 real disconnect cycles against the Python
   * bridge (2026-08-27 soak, archived at
   * ~/soak-archives/2026-08-27-tra1153-writepath-ab): socket close -> device
   * released is median 16ms, p99 21ms, MAX 30ms. 250ms keeps ~8x margin over the
   * worst case actually observed.
   *
   * The value before that was 1100ms, commented "1.1s to ensure server is ready"
   * -- timing copied from the TypeScript bridge that has since been deleted, so
   * it was 37x the real figure and paid on every disconnect in every test.
   */
  postDisconnectDelay: number;
  /** Multiplier applied to the retry delay after each failed attempt. */
  retryBackoffMultiplier: number;
  /** Whether connect retries and the post-disconnect wait announce themselves. */
  logRetries: boolean;
}

/**
 * The defaults, as plain literals with no runtime behind them.
 *
 * They used to be `parseInt(process.env.X || '...')` evaluated at MODULE SCOPE --
 * a Node API, at import time, in the file that is the single runtime-agnostic
 * implementation. The browser bundle could only load it because
 * scripts/build-browser-bundle.js substituted all five reads with esbuild
 * `define` entries at build time.
 *
 * That substitution was a SECOND source for a value that has one, and it drifted:
 * the define said BLE_MCP_MOCK_CLEANUP_DELAY was "1100" long after this file's
 * default became 250, so every browser test paid 4.4x the measured figure while
 * the source read 250 to anyone checking. One contract, two behaviours, selected
 * by packaging -- which is the defect TRA-1187 exists to close.
 */
export const DEFAULT_MOCK_CONFIG: MockConfig = {
  connectRetryDelay: 1200,
  maxConnectRetries: 20,
  postDisconnectDelay: 250,
  retryBackoffMultiplier: 1.3,
  logRetries: true
};

/** Set by `updateMockConfig`. Beats the environment; the environment beats the defaults. */
let configOverrides: Partial<MockConfig> = {};

/**
 * The environment, if there is one, reached through `globalThis` so a browser
 * finds nothing rather than throwing on a bare `process`.
 */
function environmentConfig(): Partial<MockConfig> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  if (!env) return {};

  // An unparseable value is IGNORED, not propagated. parseInt('banana') is NaN,
  // and NaN as a delay is worse than a wrong number: every comparison against it
  // is false, so the wait it configures silently disappears.
  const int = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const value = parseInt(raw, 10);
    return Number.isFinite(value) ? value : undefined;
  };
  const float = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const value = parseFloat(raw);
    return Number.isFinite(value) ? value : undefined;
  };

  const config: Partial<MockConfig> = {};

  const connectRetryDelay = int(env.BLE_MCP_MOCK_RETRY_DELAY);
  if (connectRetryDelay !== undefined) config.connectRetryDelay = connectRetryDelay;

  const maxConnectRetries = int(env.BLE_MCP_MOCK_MAX_RETRIES);
  if (maxConnectRetries !== undefined) config.maxConnectRetries = maxConnectRetries;

  const postDisconnectDelay = int(env.BLE_MCP_MOCK_CLEANUP_DELAY);
  if (postDisconnectDelay !== undefined) config.postDisconnectDelay = postDisconnectDelay;

  const retryBackoffMultiplier = float(env.BLE_MCP_MOCK_BACKOFF);
  if (retryBackoffMultiplier !== undefined) config.retryBackoffMultiplier = retryBackoffMultiplier;

  if (env.BLE_MCP_MOCK_LOG_RETRIES !== undefined) {
    config.logRetries = env.BLE_MCP_MOCK_LOG_RETRIES !== 'false';
  }

  return config;
}

/**
 * The config in force right now: defaults < environment < updateMockConfig().
 *
 * Resolved on every call rather than cached. It is read a handful of times per
 * connect or disconnect, so the cost is nothing -- and caching would restore the
 * property that made the module-scope read a trap: a value set after import never
 * landing, with nothing at the call site to say so.
 */
export function resolveMockConfig(): MockConfig {
  return { ...DEFAULT_MOCK_CONFIG, ...environmentConfig(), ...configOverrides };
}

/**
 * Allow runtime configuration updates. Wins over both the environment and the
 * defaults; `null` clears back to asking them again.
 *
 * The clear is not a convenience. Without it the only way back from an override
 * is to pass the defaults explicitly, which does not restore the default -- it
 * PINS it, above the environment, permanently. Same shape as
 * `testing.setAvailability(null)`, and for the same reason: a knob that can only
 * be set to the other constant is lying for the rest of the process's life.
 */
export function updateMockConfig(updates: Partial<MockConfig> | null): void {
  configOverrides = updates === null ? {} : { ...configOverrides, ...updates };
}

// Mock BluetoothRemoteGATTServer
class MockBluetoothRemoteGATTServer {
  connected = false;

  constructor(public device: MockBluetoothDevice) {}

  async connect(): Promise<MockBluetoothRemoteGATTServer> {
    let lastError: Error | null = null;
    const config = resolveMockConfig();
    let retryDelay = config.connectRetryDelay;
    
    for (let attempt = 1; attempt <= config.maxConnectRetries; attempt++) {
      try {
        // Pass BLE configuration including session if available
        const connectOptions: any = {};
        // Only add device if a specific device name was provided
        if (this.device.name) {
          connectOptions.device = this.device.name;
        }
        if (this.device.bleConfig) {
          Object.assign(connectOptions, this.device.bleConfig);
          // Map sessionId to session for WebSocketTransport
          if (connectOptions.sessionId && !connectOptions.session) {
            connectOptions.session = connectOptions.sessionId;
            console.log(`[MockGATT] Using session ID for WebSocket: ${connectOptions.sessionId}`);
          }
          // Log service UUID if present
          if (connectOptions.service) {
            console.log(`[MockGATT] Using service UUID: ${connectOptions.service}`);
          }
        }
        
        console.log(`[MockGATT] WebSocket connect options:`, JSON.stringify(connectOptions));
        
        await this.device.transport.connect(connectOptions);
        
        // Store session ID if one was generated or provided
        const sessionId = this.device.transport.getSessionId();
        if (sessionId) {
          this.device.sessionId = sessionId;
        }
        this.connected = true;
        
        if (attempt > 1 && config.logRetries) {
          console.log(`[Mock] Connected successfully after ${attempt} attempts`);
        }
        
        return this;
      } catch (error: any) {
        lastError = error;
        
        // Check if error is retryable (bridge busy states)
        const retryableErrors = [
          'Bridge is disconnecting',
          'Bridge is connecting', 
          'only ready state accepts connections'
        ];
        
        const isRetryable = retryableErrors.some(msg => 
          error.message?.includes(msg)
        );
        
        if (isRetryable && attempt < config.maxConnectRetries) {
          if (config.logRetries) {
            console.log(`[Mock] Bridge busy (${error.message}), retry ${attempt}/${config.maxConnectRetries} in ${retryDelay}ms...`);
          }
          
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          
          // Exponential backoff for subsequent retries
          retryDelay = Math.min(
            retryDelay * config.retryBackoffMultiplier,
            10000 // Max 10 second delay
          );
          
          continue;
        }
        
        // Non-retryable error or max retries reached
        throw error;
      }
    }
    
    // If we get here, we've exhausted retries
    throw lastError || new Error('Failed to connect after maximum retries');
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return; // Already disconnected
    }

    // Synchronous with respect to `connected`, matching a real GATT server: the
    // flag flips before any await, so a consumer checking it in a teardown path
    // never sees a server that has already gone reporting itself present.
    //
    // The transport close is still awaited below -- the command path is released
    // when the SERVER processes the socket close, so callers must still await
    // this method before reconnecting or they race their own release.
    this.connected = false;
    
    // Closing the WebSocket is what releases the bridge's command path -- there
    // is no pool behind it. Callers must AWAIT this: the release lands when the
    // server processes the close, so a fire-and-forget disconnect lets the next
    // connect race ahead of it and be refused as busy by its own session.
    try {
      await this.device.transport.disconnect();
    } catch (error) {
      console.warn('[Mock] WebSocket disconnect error:', error);
    }
    
    this.connected = false;
    
    // Optional post-disconnect delay for tests that need it
    const config = resolveMockConfig();
    if (config.postDisconnectDelay > 0) {
      if (config.logRetries) {
        console.log(`[Mock] Post-disconnect delay: ${config.postDisconnectDelay}ms`);
      }
      await new Promise(resolve => setTimeout(resolve, config.postDisconnectDelay));
    }
  }
  
  /** One service instance per UUID -- see the note on the characteristic cache. */
  private services = new Map<string, MockBluetoothRemoteGATTService>();

  async getPrimaryService(serviceUuid: string): Promise<MockBluetoothRemoteGATTService> {
    if (!this.connected) {
      throw new Error('GATT Server not connected');
    }
    const existing = this.services.get(serviceUuid);
    if (existing) return existing;
    const service = new MockBluetoothRemoteGATTService(this, serviceUuid);
    this.services.set(serviceUuid, service);
    return service;
  }
}

// Mock BluetoothDevice
class MockBluetoothDevice {
  public gatt: MockBluetoothRemoteGATTServer;
  public transport: WebSocketTransport;
  public bleConfig: { 
    service: string; 
    write?: string; 
    notify?: string; 
    sessionId: string; 
    deviceId?: string;
    deviceName?: string;
    timeout: number;
    onMultipleDevices: 'error' | 'first';
  };
  private characteristics: Map<string, MockBluetoothRemoteGATTCharacteristic> = new Map();
  private isTransportSetup = false;
  public sessionId?: string;

  constructor(
    public id: string,
    public name: string,
    serverUrl: string,
    bleConfig: { 
      service: string; 
      write?: string; 
      notify?: string; 
      sessionId: string; 
      deviceId?: string;
      deviceName?: string;
      timeout: number;
      onMultipleDevices: 'error' | 'first';
    }
  ) {
    this.transport = new WebSocketTransport(serverUrl);
    this.gatt = new MockBluetoothRemoteGATTServer(this);
    this.bleConfig = bleConfig;
    this.sessionId = bleConfig.sessionId;
  }

  // Register a characteristic for notifications
  registerCharacteristic(uuid: string, characteristic: MockBluetoothRemoteGATTCharacteristic): void {
    this.characteristics.set(uuid, characteristic);
    this.setupTransportHandler();
  }

  private setupTransportHandler(): void {
    if (this.isTransportSetup) return;
    this.isTransportSetup = true;
    
    this.transport.onMessage((msg) => {
      if (msg.type === 'data' && msg.data) {
        const data = new Uint8Array(msg.data);
        // Forward to all characteristics that have notification handlers
        this.characteristics.forEach(char => {
          char.handleTransportMessage(data);
        });
      } else if (msg.type === 'warning') {
        // The handshake handler in ws-transport catches a warning sent before
        // `connected`; this catches one sent after. Both are needed — without
        // this branch a post-handshake warning falls past `data` and
        // `disconnected` onto the floor, and the guard in test_protocol.py
        // would still be green because the type has a consumer somewhere.
        console.warn(`[Mock] Server warning: ${msg.warning}`);
      } else if (msg.type === 'disconnected') {
        // Ensure GATT server knows it's disconnected
        if (this.gatt.connected) {
          this.gatt.connected = false;
        }
        // Trigger disconnection events
        this.dispatchEvent('gattserverdisconnected');
      }
    });
  }

  private disconnectHandlers: Array<{ handler: () => void; once: boolean }> = [];

  addEventListener(event: string, handler: any, options?: AddEventListenerOptions): void {
    if (event !== 'gattserverdisconnected') return;
    const once = readListenerOptions(options);
    if (this.disconnectHandlers.some(entry => entry.handler === handler)) return;
    this.disconnectHandlers.push({ handler, once });
  }

  /**
   * The counterpart this class never had.
   *
   * `addEventListener` existed alone, so a registered disconnect handler could
   * not be removed by any means -- a consumer that attached one per connection
   * accumulated them for the page's lifetime, and each reconnect fired every
   * handler from every prior connection.
   */
  removeEventListener(event: string, handler: any): void {
    if (event !== 'gattserverdisconnected') return;
    const index = this.disconnectHandlers.findIndex(entry => entry.handler === handler);
    if (index > -1) this.disconnectHandlers.splice(index, 1);
  }

  private dispatchEvent(eventType: string): void {
    if (eventType === 'gattserverdisconnected') {
      const entries = [...this.disconnectHandlers];
      for (const entry of entries) {
        if (entry.once) {
          const index = this.disconnectHandlers.indexOf(entry);
          if (index > -1) this.disconnectHandlers.splice(index, 1);
        }
        entry.handler();
      }
    }
  }
}

// Mock Bluetooth API
export class MockBluetooth {
  private bleConfig: { 
    service: string; 
    write?: string; 
    notify?: string; 
    sessionId: string; 
    deviceId?: string;
    deviceName?: string;
    timeout: number;
    onMultipleDevices: 'error' | 'first';
  };

  constructor(private serverUrl: string, bleConfig: { 
    service: string; 
    write?: string; 
    notify?: string; 
    sessionId: string; 
    deviceId?: string;
    deviceName?: string;
    timeout: number;
    onMultipleDevices: 'error' | 'first';
  }) {
    this.bleConfig = bleConfig;
  }

  /**
   * Set only by `testing.setAvailability`. `null` means "ask the bridge", which
   * is the default and the only state a run reaches without opting in.
   */
  private availabilityOverride: boolean | null = null;

  public readonly testing: BluetoothTesting = {
    getReaderState: async (): Promise<ReaderState | null> => this.fetchStatus(),

    setAvailability: (value: boolean | null): void => {
      this.availabilityOverride = value;
      if (value !== null) {
        // Say so. A forced reading that is silent is indistinguishable from a
        // real one, and this method exists because that was the old bug.
        console.warn(
          `[MockBluetooth] getAvailability() is forced to ${value} until ` +
            'setAvailability(null) clears it; the bridge is not being consulted.'
        );
      }
    },

    testCommand: async (options: TestCommandOptions): Promise<TestResult> => {
      // Input validation first
      if (!options.device || !options.writeCharacteristic || !options.notifyCharacteristic) {
        throw new Error('Missing required options: device, writeCharacteristic, and notifyCharacteristic are required');
      }
      
      // Promise-based timeout handling
      return new Promise<TestResult>((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ success: false, timeout: true, error: 'Command timeout' });
        }, options.timeout || 2000);
        
        // Event listener cleanup pattern
        const handler = (event: any) => {
          clearTimeout(timeout);
          const data = new Uint8Array(event.target.value.buffer);
          
          // Custom validation function
          const isValid = options.validateResponse ? 
            options.validateResponse(data) : data.length > 0;
            
          resolve({
            success: isValid,
            response: data,
            responseHex: this.testing.utils.toHex(data),
            error: isValid ? undefined : 'Invalid response format'
          });
        };
        
        // Setup listener and send command
        options.notifyCharacteristic.addEventListener('characteristicvaluechanged', handler, { once: true });
        options.writeCharacteristic.writeValue(options.command).catch((error: any) => {
          clearTimeout(timeout);
          resolve({ success: false, error: error.message });
        });
      });
    },
    
    simulateNotification: async (options: SimulateNotificationOptions): Promise<void> => {
      // Delay handling
      if (options.delay && options.delay > 0) {
        await new Promise(resolve => setTimeout(resolve, options.delay));
      }
      
      // Log notification dispatch details
      console.log('ble-mcp-test: dispatching notify event', {
        characteristic: options.characteristic.uuid,
        dataLength: options.data.length,
        data: Array.from(options.data).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')
      });
      
      const characteristic = options.characteristic as any;

      // A simulated notification is an INSTRUCTION, not a device event, and that
      // is why it does not share handleTransportMessage's silent drop. A frame
      // arriving for an unsubscribed characteristic is something a radio really
      // does, so the transport path swallows it. A test author calling this
      // method has explicitly asked for delivery, and swallowing that request
      // would make this API a check that cannot go red -- it would deliver
      // nothing, report nothing, and the test would pass having asserted on an
      // empty list.
      //
      // So the two paths agree where it matters (a subscribed characteristic
      // receives an indistinguishable event) and diverge deliberately where the
      // caller is one of ours to help.
      if (
        characteristic instanceof MockBluetoothRemoteGATTCharacteristic &&
        !characteristic.isSubscribed
      ) {
        throw new Error(
          `Cannot simulate a notification on characteristic ${characteristic.uuid}: ` +
            'it is not subscribed. Call startNotifications() first -- a real ' +
            'characteristic delivers nothing until you do, so a test that skips ' +
            'it would pass here and receive silence on hardware.'
        );
      }

      // Respect the byte range: `data` may be a view into a larger buffer, and
      // `new DataView(buf)` would hand the app the whole thing.
      characteristic.value = new DataView(
        options.data.buffer,
        options.data.byteOffset,
        options.data.byteLength
      );

      // Primary path: dispatch the standard Web Bluetooth DOM event. This is
      // what a real MockBluetoothRemoteGATTCharacteristic exposes -- its
      // triggerNotification is private, so dispatchEvent IS the public surface.
      if (typeof characteristic.dispatchEvent === 'function') {
        const event = new CustomEvent('characteristicvaluechanged', {
          detail: { target: characteristic }
        });

        // Set the target property on the event
        Object.defineProperty(event, 'target', {
          value: { value: characteristic.value },
          writable: false
        });

        characteristic.dispatchEvent(event);
      } else if (typeof characteristic.triggerNotification === 'function') {
        characteristic.triggerNotification(options.data);
      } else if (typeof characteristic.simulateNotification === 'function') {
        // Legacy shape, kept because callers may hold hand-rolled stubs.
        characteristic.simulateNotification(options.data);
      } else {
        // Say what is wrong rather than letting `undefined is not a function`
        // surface from three frames down.
        throw new Error(
          'Unable to simulate notification: the characteristic exposes none of ' +
          'dispatchEvent, triggerNotification or simulateNotification'
        );
      }

      // Log successful dispatch
      console.log('ble-mcp-test: notify event dispatched successfully');
    },
    
    utils: {
      toHex: (data: Uint8Array): string => {
        return Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
      },
      
      fromHex: (hex: string): Uint8Array => {
        // Handle "A7 B3 02" format and "A7B302" format
        const cleaned = hex.replace(/\s+/g, '');
        const bytes = [];
        for (let i = 0; i < cleaned.length; i += 2) {
          bytes.push(parseInt(cleaned.substr(i, 2), 16));
        }
        return new Uint8Array(bytes);
      },
      
      equals: (a: Uint8Array, b: Uint8Array): boolean => {
        return a.length === b.length && a.every((val, i) => val === b[i]);
      }
    }
  };
  
  
  async requestDevice(options?: any): Promise<MockBluetoothDevice> {
    // Bypass all dialogs - immediately return a mock device
    let deviceName: string | undefined;
    let serviceUuid: string | undefined;
    
    // Extract filters from requestDevice options
    if (options?.filters) {
      for (const filter of options.filters) {
        // Extract device name if provided
        if (filter.namePrefix) {
          deviceName = filter.namePrefix;
        }
        
        // Extract service UUID if provided
        if (filter.services && filter.services.length > 0) {
          // Take the first service UUID from the filter
          serviceUuid = filter.services[0];
          console.log(`[MockBluetooth] Extracted service UUID from filter: ${serviceUuid}`);
        }
        
        // If we have both, we can break early
        if (deviceName && serviceUuid) {
          break;
        }
      }
    }
    
    // Create effective config, preferring filter values over injected config
    const effectiveConfig = {
      ...this.bleConfig,
      sessionId: this.bleConfig.sessionId
    };
    
    // Override with service UUID from filter if provided
    if (serviceUuid) {
      effectiveConfig.service = serviceUuid;
    }
    
    const device = new MockBluetoothDevice(
      'mock-device-id',
      deviceName || '',  // Empty string when no device specified
      this.serverUrl,
      effectiveConfig
    );
    this.devices.push(device);

    return device;
  }

  /**
   * Every device this instance has minted, so `teardown` can reach them.
   *
   * A fresh device per `requestDevice` is deliberate -- it is what keeps a
   * reconnect from colliding with the previous session's characteristic objects.
   * The cost is that nothing else holds a reference, so without this list an
   * instance being replaced would strand live transports with no way to reach them.
   */
  private devices: MockBluetoothDevice[] = [];

  /**
   * Release everything this instance owns. Idempotent, and never throws.
   *
   * Called when a second injection replaces this mock. Failing here must not
   * prevent the replacement: a teardown that throws would leave BOTH the old
   * instance live and the new one uninstalled, which is worse than the leak it
   * was trying to prevent.
   */
  async teardown(): Promise<void> {
    const devices = this.devices.splice(0);
    await Promise.all(devices.map(async device => {
      try {
        await device.gatt.disconnect();
      } catch (error) {
        console.warn('[MockBluetooth] teardown: disconnect failed, continuing:', error);
      }
    }));
  }

  /**
   * The URL of the bridge's status endpoint, derived from the WebSocket URL.
   *
   * ws -> http, wss -> https, same host and port. The status endpoint is served
   * by the bridge on the WebSocket port precisely so this derivation is
   * possible without a second configured value that could drift out of step.
   */
  private get statusUrl(): string {
    const u = new URL(this.serverUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/status';
    u.search = '';
    return u.toString();
  }

  private async fetchStatus(): Promise<ReaderState | null> {
    try {
      const res = await fetch(this.statusUrl, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      return (await res.json()) as ReaderState;
    } catch {
      // Unreachable, refused, timed out, or not JSON. All of them mean the same
      // thing to a caller: nobody could be asked.
      return null;
    }
  }

  /**
   * Is a Bluetooth adapter reachable?
   *
   * This is the Web Bluetooth spec question, and the answer is whether the
   * bridge responds -- not whether the reader is free. A reader held by another
   * session still reports `true`, because "someone else is using it" is a
   * connect-time answer (`Device is busy`, naming the holder), not an
   * availability one. Overloading this boolean would tell a consumer asking
   * "does this environment do Bluetooth" that it does not, because a colleague
   * is mid-run.
   *
   * For "is it free, who has it, since when", use
   * `navigator.bluetooth.testing.getReaderState()`.
   *
   * This previously returned a hardcoded `true` -- a check that could never go
   * red, reporting an available adapter with no bridge running at all.
   */
  async getAvailability(): Promise<boolean> {
    if (this.availabilityOverride !== null) {
      // Deliberately before the fetch: a test simulating "no Bluetooth here"
      // should not need a bridge running to do it.
      return this.availabilityOverride;
    }
    try {
      const res = await fetch(this.statusUrl, { signal: AbortSignal.timeout(2000) });
      // Any HTTP answer means something is listening and speaking for the
      // bridge. The body is not consulted on purpose: a 426, a 404 from a
      // future version, or a 200 all establish reachability equally.
      return res.status > 0;
    } catch {
      return false;
    }
  }
}


/**
 * Configuration interface for Web Bluetooth mock
 * All parameters marked REQUIRED are mandatory (breaking change in v0.6.0)
 * 
 * @see {@link https://github.com/ble-mcp-test/ble-mcp-test#readme} - Getting Started Guide
 * @see {@link https://github.com/ble-mcp-test/ble-mcp-test/tree/main/examples} - Code Examples
 * @see {@link https://github.com/ble-mcp-test/ble-mcp-test/tree/main/docs} - Documentation
 */
export interface WebBleMockConfig {
  sessionId: string;      // REQUIRED - session management
  serverUrl: string;      // REQUIRED - bridge server URL  
  service: string;        // REQUIRED - primary service UUID
  write?: string;         // OPTIONAL - write characteristic UUID
  notify?: string;        // OPTIONAL - notify characteristic UUID
  deviceId?: string;      // OPTIONAL - specific device ID
  deviceName?: string;    // OPTIONAL - device name filter
  timeout?: number;       // OPTIONAL - discovery timeout (default: 5000ms)
  onMultipleDevices?: 'error' | 'first';  // OPTIONAL - multiple device behavior (default: 'error')
}

/**
 * Inject the Web Bluetooth mock into the browser
 * Replaces navigator.bluetooth with a mock implementation
 * 
 * @example Basic usage with required parameters (v0.6.0+)
 * ```javascript
 * import os from 'os';
 * 
 * window.WebBleMock.injectWebBluetoothMock({
 *   sessionId: `test-session-${os.hostname()}`,  // Unique per developer machine
 *   serverUrl: 'ws://localhost:25153',            // Bridge server URL
 *   service: '9800'                              // Your BLE service UUID
 * });
 * ```
 * 
 * @example With optional parameters
 * ```javascript
 * window.WebBleMock.injectWebBluetoothMock({
 *   sessionId: `test-session-${os.hostname()}`,
 *   serverUrl: 'ws://localhost:25153',
 *   service: '9800',
 *   write: '9900',     // Optional: write characteristic UUID
 *   notify: '9901',    // Optional: notify characteristic UUID
 *   timeout: 10000     // Optional: connection timeout
 * });
 * ```
 * 
 * @see {@link https://github.com/ble-mcp-test/ble-mcp-test/tree/main/examples/smart-mock-helper.ts} - Auto-detect dev vs CI context
 * @see {@link https://github.com/ble-mcp-test/ble-mcp-test/tree/main/docs/UNIFIED-TESTING.md} - Unified testing approach
 * @see {@link https://github.com/ble-mcp-test/ble-mcp-test/tree/main/docs/TESTING-PATTERNS.md} - Testing patterns
 */
export function injectWebBluetoothMock(config: WebBleMockConfig): void {
  if (typeof window === 'undefined') {
    console.warn('injectWebBluetoothMock: Not in browser environment');
    return;
  }
  
  // Validate required parameters
  if (!config.sessionId) {
    throw new Error('sessionId is required - this prevents session conflicts and ensures predictable BLE connection management');
  }
  if (!config.serverUrl) {
    throw new Error('serverUrl is required - specify the bridge server URL (e.g., "ws://localhost:25153")');
  }
  if (!config.service) {
    throw new Error('service is required - specify the primary service UUID for device discovery');
  }
  
  // Create backward-compatible bleConfig for internal use
  const bleConfig = {
    service: config.service,
    write: config.write,
    notify: config.notify,
    sessionId: config.sessionId,
    deviceId: config.deviceId,
    deviceName: config.deviceName,
    timeout: config.timeout || 5000,
    onMultipleDevices: config.onMultipleDevices || 'error'
  };
  
  // A second injection used to ORPHAN the first instance: its device, transport
  // and characteristics survived with listeners attached and the socket open,
  // while navigator.bluetooth pointed somewhere else. Nothing told the old
  // transport it had been replaced, so it went on believing it was connected --
  // the silent-fallback class, succeeding against the wrong object.
  //
  // Tear down rather than reuse. Reuse would make the orphan merely unlikely;
  // this makes it unreachable, and it is the honest behaviour for a caller
  // deliberately re-injecting with different config.
  const existing = (window.navigator as any).bluetooth;
  if (existing instanceof MockBluetooth) {
    // Deliberately not awaited: injection is synchronous by contract, and its
    // callers are page-setup scripts. The release still lands -- the bridge frees
    // the device when the socket closes, measured at a 30ms worst case.
    void existing.teardown();
  }

  // Try to replace navigator.bluetooth with our mock
  const mockBluetooth = new MockBluetooth(config.serverUrl, bleConfig);
  
  try {
    // First attempt: direct assignment
    (window.navigator as any).bluetooth = mockBluetooth;
  } catch {
    // Second attempt: defineProperty
    try {
      Object.defineProperty(window.navigator, 'bluetooth', {
        value: mockBluetooth,
        configurable: true,
        writable: true
      });
    } catch {
      // Third attempt: create a new navigator object
      const nav = Object.create(window.navigator);
      nav.bluetooth = mockBluetooth;
      
      // Replace window.navigator
      Object.defineProperty(window, 'navigator', {
        value: nav,
        configurable: true,
        writable: true
      });
    }
  }
}