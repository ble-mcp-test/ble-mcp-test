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
    
    try {
      // Send force_cleanup before disconnecting
      if (this.device.transport.isConnected()) {
        if (MOCK_CONFIG.logRetries) {
          console.log('[Mock] Sending force_cleanup before disconnect');
        }
        
        await this.device.transport.forceCleanup();
        
        // Small delay to ensure cleanup message is processed
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      // Log but continue with disconnect even if cleanup fails
      console.warn('[Mock] Force cleanup failed during disconnect:', error);
    }
    
    // Now disconnect the WebSocket
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
  public bleConfig?: { service?: string; write?: string; notify?: string; sessionId?: string; generateSession?: boolean };
  private characteristics: Map<string, MockBluetoothRemoteGATTCharacteristic> = new Map();
  private isTransportSetup = false;
  public sessionId?: string;

  constructor(
    public id: string,
    public name: string,
    serverUrl?: string,
    bleConfig?: { service?: string; write?: string; notify?: string; sessionId?: string; generateSession?: boolean }
  ) {
    this.transport = new WebSocketTransport(serverUrl);
    this.gatt = new MockBluetoothRemoteGATTServer(this);
    this.bleConfig = bleConfig;
    this.sessionId = bleConfig?.sessionId;
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
  private bleConfig?: { service?: string; write?: string; notify?: string; sessionId?: string; generateSession?: boolean };
  private autoSessionId?: string;

  constructor(private serverUrl?: string, bleConfig?: { service?: string; write?: string; notify?: string; sessionId?: string; generateSession?: boolean }) {
    this.bleConfig = bleConfig;
    
    // Auto-generate session ID if not provided
    if (!bleConfig?.sessionId) {
      this.autoSessionId = this.generateAutoSessionId();
    }
  }
  
  private generateAutoSessionId(): string {
    // Simple: Playwright gets a directory-based ID, browsers get random
    if (this.isPlaywrightEnvironment()) {
      // Use the current working directory name as the session ID base
      // This allows all tests in the same project to share the connection pool
      const projectName = this.getProjectName();
      return `playwright-${projectName}`;
    }
    
    // For interactive use, just timestamp + random
    return `session-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  }
  
  private getProjectName(): string {
    // Try to get a stable project identifier
    if (typeof process !== 'undefined' && process.cwd) {
      // Get the last part of the current working directory
      const cwd = process.cwd();
      const parts = cwd.split(/[\/\\]/);
      return parts[parts.length - 1] || 'test';
    }
    
    // Fallback for browser environment - use hostname
    if (typeof window !== 'undefined') {
      return window.location.hostname.replace(/[^a-z0-9]/gi, '-') || 'test';
    }
    
    return 'test';
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
  
  private isPlaywrightEnvironment(): boolean {
    // Simple check: Playwright tests typically use about:blank or have playwright in the user agent
    if (typeof window !== 'undefined') {
      // Check if we're in about:blank (common for Playwright)
      if (window.location.href === 'about:blank') {
        return true;
      }
      
      // Check for Playwright marker in window object (if injected by test)
      if ((window as any).playwright) {
        return true;
      }
    }
    
    // Check for headless Chrome (common in Playwright)
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
      return navigator.userAgent.includes('HeadlessChrome');
    }
    
    return false;
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
    // Use the namePrefix filter if provided, otherwise don't specify device
    let deviceName: string | undefined;
    
    if (options?.filters) {
      for (const filter of options.filters) {
        if (filter.namePrefix) {
          // If a specific device name is provided in the filter, use it
          deviceName = filter.namePrefix;
          break;
        }
      }
    }
    
    // Create and return mock device with BLE configuration
    // Use auto-generated session ID if no explicit sessionId provided
    const effectiveConfig = {
      ...this.bleConfig,
      sessionId: this.bleConfig?.sessionId || this.autoSessionId
    };
    
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

// Export function to inject mock into window
export function injectWebBluetoothMock(
  serverUrl?: string, 
  bleConfig?: { service?: string; write?: string; notify?: string; sessionId?: string; generateSession?: boolean }
): void {
  if (typeof window === 'undefined') {
    console.warn('injectWebBluetoothMock: Not in browser environment');
    return;
  }
  
  // Try to replace navigator.bluetooth with our mock
  const mockBluetooth = new MockBluetooth(serverUrl, bleConfig);
  
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