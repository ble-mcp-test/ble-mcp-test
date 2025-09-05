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

// Mock BluetoothRemoteGATTCharacteristic
class MockBluetoothRemoteGATTCharacteristic {
  private notificationHandlers: Array<(event: any) => void> = [];

  constructor(
    private service: MockBluetoothRemoteGATTService,
    public uuid: string
  ) {
    // Register this characteristic with the device for transport message handling
    this.service.server.device.registerCharacteristic(this.uuid, this);
  }

  async writeValue(value: BufferSource): Promise<void> {
    const data = new Uint8Array(value as ArrayBuffer);
    await this.service.server.device.transport.send(data);
  }

  async startNotifications(): Promise<MockBluetoothRemoteGATTCharacteristic> {
    // Notifications are automatically started by WebSocketTransport
    return this;
  }

  async stopNotifications(): Promise<MockBluetoothRemoteGATTCharacteristic> {
    // In a real implementation, this would stop notifications
    // For our mock, we don't need to do anything special
    return this;
  }

  addEventListener(event: string, handler: any): void {
    if (event === 'characteristicvaluechanged') {
      // Store handler for both real and simulated notifications
      this.notificationHandlers.push(handler);
    }
  }
  
  removeEventListener(event: string, handler: any): void {
    if (event === 'characteristicvaluechanged') {
      const index = this.notificationHandlers.indexOf(handler);
      if (index > -1) {
        this.notificationHandlers.splice(index, 1);
      }
    }
  }

  // Called by the device when transport receives data
  handleTransportMessage(data: Uint8Array): void {
    if (this.notificationHandlers.length > 0) {
      this.triggerNotification(data);
    }
  }

  /**
   * Simulate a notification from the device (for testing)
   * This allows tests to inject data as if it came from the real device
   * 
   * @example
   * // Simulate button press event
   * characteristic.simulateNotification(new Uint8Array([0xA7, 0xB3, 0x01, 0xFF]));
   * // Simulate button release event  
   * characteristic.simulateNotification(new Uint8Array([0xA7, 0xB3, 0x01, 0x00]));
   */
  simulateNotification(data: Uint8Array): void {
    if (!this.service.server.connected) {
      throw new Error('GATT Server not connected');
    }
    
    // Log for debugging if enabled
    if (MOCK_CONFIG.logRetries) {
      const hex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`[Mock] Simulating device notification: ${hex}`);
    }
    
    this.triggerNotification(data);
  }

  private triggerNotification(data: Uint8Array): void {
    // Create a mock event with the data matching Web Bluetooth API structure
    const mockEvent = {
      target: {
        value: {
          buffer: data.buffer,
          byteLength: data.byteLength,
          byteOffset: data.byteOffset,
          getUint8: (index: number) => data[index]
        }
      }
    };
    
    // Trigger all registered handlers
    this.notificationHandlers.forEach(handler => {
      handler(mockEvent);
    });
  }
}

// Mock BluetoothRemoteGATTService
class MockBluetoothRemoteGATTService {
  constructor(
    public server: MockBluetoothRemoteGATTServer,
    public uuid: string
  ) {}

  async getCharacteristic(characteristicUuid: string): Promise<MockBluetoothRemoteGATTCharacteristic> {
    // Return mock characteristic
    return new MockBluetoothRemoteGATTCharacteristic(this, characteristicUuid);
  }
}

// Configuration for mock behavior - can be overridden at runtime
let MOCK_CONFIG = {
  // Match server's expected recovery timing:
  // - Clean disconnect: 1s (new default)
  // - Failed connection: 5s+ (server default)
  connectRetryDelay: parseInt(process.env.BLE_MCP_MOCK_RETRY_DELAY || '1200', 10), // 1.2s to cover 1s clean recovery
  maxConnectRetries: parseInt(process.env.BLE_MCP_MOCK_MAX_RETRIES || '20', 10), // More retries for 5s+ recovery
  postDisconnectDelay: parseInt(process.env.BLE_MCP_MOCK_CLEANUP_DELAY || '1100', 10), // 1.1s to ensure server is ready
  retryBackoffMultiplier: parseFloat(process.env.BLE_MCP_MOCK_BACKOFF || '1.3'), // Gentler backoff
  logRetries: process.env.BLE_MCP_MOCK_LOG_RETRIES !== 'false'
};

// Allow runtime configuration updates
export function updateMockConfig(updates: Partial<typeof MOCK_CONFIG>): void {
  MOCK_CONFIG = { ...MOCK_CONFIG, ...updates };
}

// Mock BluetoothRemoteGATTServer
class MockBluetoothRemoteGATTServer {
  connected = false;

  constructor(public device: MockBluetoothDevice) {}

  async connect(): Promise<MockBluetoothRemoteGATTServer> {
    let lastError: Error | null = null;
    let retryDelay = MOCK_CONFIG.connectRetryDelay;
    
    for (let attempt = 1; attempt <= MOCK_CONFIG.maxConnectRetries; attempt++) {
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
        
        if (attempt > 1 && MOCK_CONFIG.logRetries) {
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
        
        if (isRetryable && attempt < MOCK_CONFIG.maxConnectRetries) {
          if (MOCK_CONFIG.logRetries) {
            console.log(`[Mock] Bridge busy (${error.message}), retry ${attempt}/${MOCK_CONFIG.maxConnectRetries} in ${retryDelay}ms...`);
          }
          
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          
          // Exponential backoff for subsequent retries
          retryDelay = Math.min(
            retryDelay * MOCK_CONFIG.retryBackoffMultiplier,
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
    
    // Just disconnect the WebSocket - leave BLE connection pooled
    try {
      await this.device.transport.disconnect();
    } catch (error) {
      console.warn('[Mock] WebSocket disconnect error:', error);
    }
    
    this.connected = false;
    
    // Optional post-disconnect delay for tests that need it
    if (MOCK_CONFIG.postDisconnectDelay > 0) {
      if (MOCK_CONFIG.logRetries) {
        console.log(`[Mock] Post-disconnect delay: ${MOCK_CONFIG.postDisconnectDelay}ms`);
      }
      await new Promise(resolve => setTimeout(resolve, MOCK_CONFIG.postDisconnectDelay));
    }
  }
  
  async forceCleanup(): Promise<void> {
    console.warn('[Mock] WARNING: Force cleanup is broken and creates zombies');
    await this.device.transport.forceCleanup();
  }

  async getPrimaryService(serviceUuid: string): Promise<MockBluetoothRemoteGATTService> {
    if (!this.connected) {
      throw new Error('GATT Server not connected');
    }
    return new MockBluetoothRemoteGATTService(this, serviceUuid);
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

  private disconnectHandlers: Array<() => void> = [];

  addEventListener(event: string, handler: any): void {
    if (event === 'gattserverdisconnected') {
      this.disconnectHandlers.push(handler);
    }
  }

  private dispatchEvent(eventType: string): void {
    if (eventType === 'gattserverdisconnected') {
      this.disconnectHandlers.forEach(handler => handler());
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
  
  
  private getClientIP(): string {
    if (typeof window !== 'undefined') {
      const hostname = window.location.hostname;
      if (hostname) {
        return hostname;  // Return actual hostname (localhost, 127.0.0.1, etc.)
      }
    }
    return '127.0.0.1';
  }
  
  private getBrowser(): string {
    if (typeof navigator !== 'undefined') {
      const ua = navigator.userAgent;
      if (ua.includes('Playwright')) return 'playwright';
      if (ua.includes('Puppeteer')) return 'puppeteer';  
      if (ua.includes('HeadlessChrome')) return 'headless';
      if (ua.includes('Chrome')) return 'chrome';
      if (ua.includes('Firefox')) return 'firefox';
      if (ua.includes('Safari')) return 'safari';
      if (ua.includes('Edge')) return 'edge';
    }
    return 'browser';
  }
  
  private getStorageContext(): string {
    if (typeof window !== 'undefined') {
      return `${window.location.origin || 'unknown-origin'}`;
    }
    return 'no-window';
  }
  
  private getStableTestSuffix(): string {
    // Generate a stable suffix based on the current page URL
    // This ensures consistent session IDs across page reloads in the same test
    if (typeof window !== 'undefined') {
      const url = window.location.href;
      // Create a simple hash of the URL to use as a stable suffix
      let hash = 0;
      for (let i = 0; i < url.length; i++) {
        const char = url.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
      }
      return Math.abs(hash).toString(36);
    }
    // Fallback to timestamp if window is not available
    return Date.now().toString(36);
  }

  private getTestFilePath(): string | null {
    try {
      // Try to get test info from Playwright context
      if (typeof window !== 'undefined' && (window as any).__playwright?.testInfo) {
        const testInfo = (window as any).__playwright.testInfo;
        if (testInfo.file) {
          return this.normalizeTestPath(testInfo.file);
        }
      }
      
      // Fallback: Try to extract from stack trace
      const stack = new Error().stack;
      if (stack) {
        console.log(`[MockBluetooth] Stack trace for test path extraction:\n${stack}`);
        
        // Look for test file patterns in stack trace
        const testFilePattern = /\/(tests?|spec|e2e)\/(.*?)\.(test|spec)\.(ts|js|mjs)/;
        const lines = stack.split('\n');
        
        for (const line of lines) {
          const match = line.match(testFilePattern);
          if (match) {
            const testPath = match[2]; // The path between tests/ and .test/spec
            console.log(`[MockBluetooth] Found test path in stack: ${testPath}`);
            return this.normalizeTestPath(`tests/${testPath}`);
          }
        }
        
        console.log(`[MockBluetooth] No test path found in stack trace`);
      }
    } catch (e) {
      console.log(`[MockBluetooth] Error extracting test path: ${e instanceof Error ? e.message : String(e)}`);
    }
    
    return null;
  }
  
  private normalizeTestPath(path: string): string {
    // Normalize path separators (Windows backslashes to forward slashes)
    const normalized = path.replace(/\\/g, '/');
    
    // Extract last 2-3 path segments for uniqueness
    const segments = normalized.split('/');
    const relevantSegments: string[] = [];
    
    // Find the tests/spec/e2e directory and take segments from there
    let foundTestDir = false;
    for (let i = segments.length - 1; i >= 0; i--) {
      if (['tests', 'test', 'spec', 'e2e'].includes(segments[i])) {
        foundTestDir = true;
      }
      if (foundTestDir) {
        relevantSegments.unshift(segments[i]);
        if (relevantSegments.length >= 3) break;
      }
    }
    
    // If we didn't find a test directory, just take the last 2 segments
    if (!foundTestDir && segments.length >= 2) {
      relevantSegments.push(segments[segments.length - 2]);
      relevantSegments.push(segments[segments.length - 1]);
    }
    
    // Remove file extensions
    const result = relevantSegments.join('/').replace(/\.(test|spec)\.(ts|js|mjs)$/, '');
    
    return result;
  }

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

    return device;
  }

  async getAvailability(): Promise<boolean> {
    // Always available when using WebSocket bridge
    return true;
  }
}


// Function to get bundle version
export function getBundleVersion(): string {
  // This will be replaced during build with actual version
  return typeof (window as any).WebBleMock?.version === 'string' 
    ? (window as any).WebBleMock.version 
    : 'unknown';
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
 *   serverUrl: 'ws://localhost:8080',            // Bridge server URL
 *   service: '9800'                              // Your BLE service UUID
 * });
 * ```
 * 
 * @example With optional parameters
 * ```javascript
 * window.WebBleMock.injectWebBluetoothMock({
 *   sessionId: `test-session-${os.hostname()}`,
 *   serverUrl: 'ws://localhost:8080',
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
    throw new Error('serverUrl is required - specify the bridge server URL (e.g., "ws://localhost:8080")');
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