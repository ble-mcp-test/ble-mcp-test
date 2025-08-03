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
        const connectOptions: any = { device: this.device.name };
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
    // Hierarchical session ID generation strategy:
    // 1. window.BLE_TEST_SESSION_ID (explicit injection by test)
    // 2. process.env.BLE_TEST_SESSION_ID (environment variable)
    // 3. Playwright context detection (auto-generate from test file)
    // 4. Current random generation (fallback for interactive use)
    
    // Priority 1: Explicit injection by test
    if (typeof window !== 'undefined' && (window as any).BLE_TEST_SESSION_ID) {
      const explicitId = (window as any).BLE_TEST_SESSION_ID;
      console.log(`[MockBluetooth] Using explicit test session ID: ${explicitId}`);
      return explicitId;
    }
    
    // Priority 2: Environment variable
    if (typeof process !== 'undefined' && process.env?.BLE_TEST_SESSION_ID) {
      const envId = process.env.BLE_TEST_SESSION_ID;
      console.log(`[MockBluetooth] Using environment session ID: ${envId}`);
      return envId;
    }
    
    // Priority 3: Playwright context detection
    const isPlaywright = this.isPlaywrightEnvironment();
    if (isPlaywright) {
      const testPath = this.getTestFilePath();
      const hostname = this.getClientIP();
      
      // If we got a test path, use it
      if (testPath) {
        const deterministicId = `${hostname}-${testPath}`;
        console.log(`[MockBluetooth] Generated deterministic session ID for Playwright: ${deterministicId}`);
        return deterministicId;
      }
      
      // Otherwise, use a stable suffix based on the page URL
      // This ensures consistent session IDs across page reloads in the same test
      const stableSuffix = this.getStableTestSuffix();
      const deterministicId = `${hostname}-playwright-${stableSuffix}`;
      console.log(`[MockBluetooth] Generated deterministic session ID for Playwright: ${deterministicId}`);
      return deterministicId;
    }
    
    // Priority 4: Current random generation with localStorage persistence
    // Try to reuse existing session from localStorage
    try {
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem('ble-mock-session-id');
        if (stored) {
          console.log(`[MockBluetooth] Reusing stored session: ${stored}`);
          console.log(`[MockBluetooth] localStorage available: true, context: ${this.getStorageContext()}`);
          
          // Double-check that the stored session is still in localStorage after reading
          // This helps detect race conditions
          const doubleCheck = localStorage.getItem('ble-mock-session-id');
          if (doubleCheck !== stored) {
            console.log(`[MockBluetooth] WARNING: Session changed during read! Was ${stored}, now ${doubleCheck}`);
          }
          
          return stored;
        }
      }
    } catch (e) {
      console.log(`[MockBluetooth] localStorage error during read: ${e instanceof Error ? e.message : String(e)}`);
    }
    
    const ip = this.getClientIP();
    const browser = this.getBrowser();
    const random = Math.random().toString(36).substr(2, 4).toUpperCase();
    
    const sessionId = `${ip}-${browser}-${random}`;
    console.log(`[MockBluetooth] Generated new session: ${sessionId} (IP: ${ip}, Browser: ${browser})`);
    
    // Store for next time with race condition detection
    try {
      if (typeof localStorage !== 'undefined') {
        // Check if another instance already stored a session while we were generating
        const existingSession = localStorage.getItem('ble-mock-session-id');
        if (existingSession && existingSession !== sessionId) {
          console.log(`[MockBluetooth] Race condition detected! Another instance stored ${existingSession}, switching to that instead of ${sessionId}`);
          return existingSession;
        }
        
        localStorage.setItem('ble-mock-session-id', sessionId);
        console.log(`[MockBluetooth] Stored new session: ${sessionId}`);
        console.log(`[MockBluetooth] localStorage available: true, context: ${this.getStorageContext()}`);
      } else {
        console.log(`[MockBluetooth] localStorage not available - session won't persist`);
      }
    } catch (e) {
      console.log(`[MockBluetooth] localStorage error during write: ${e instanceof Error ? e.message : String(e)}`);
    }
    
    return sessionId;
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
    // Detect if running in Playwright or other test environments
    // Note: Playwright doesn't expose markers in the browser context, so we use heuristics
    
    // 1. Check for test-like URL patterns (file://, localhost with no real server)
    if (typeof window !== 'undefined') {
      const url = window.location.href;
      // Common test URL patterns
      if (url.startsWith('file://') || 
          url.includes('localhost/test') || 
          url.includes('127.0.0.1/test') ||
          url.includes('localhost:0/') ||
          url.includes('about:blank')) {
        // Likely a test environment
        return true;
      }
    }
    
    // 2. Check for headless browser (common in CI/test environments)
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
      const ua = navigator.userAgent.toLowerCase();
      if (ua.includes('headless')) {
        return true;
      }
    }
    
    // 3. Original checks (kept for compatibility)
    return !!(
      (typeof process !== 'undefined' && process.env?.PLAYWRIGHT_TEST_BASE_URL) ||
      (typeof window !== 'undefined' && (window as any).__playwright) ||
      (typeof navigator !== 'undefined' && navigator.userAgent?.includes('Playwright'))
    );
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
    // Use the namePrefix filter if provided, otherwise use generic name
    let deviceName = 'MockDevice000000';
    
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
      deviceName,
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

// Utility function to clear stored session (for tests)
export function clearStoredSession(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('ble-mock-session-id');
      console.log('[MockBluetooth] Cleared stored session');
    }
  } catch {
    // localStorage not available, nothing to clear
  }
}

// Utility function to set test session ID (for Playwright tests)
export function setTestSessionId(sessionId: string): void {
  if (typeof window !== 'undefined') {
    (window as any).BLE_TEST_SESSION_ID = sessionId;
    console.log(`[MockBluetooth] Set test session ID: ${sessionId}`);
  }
}

// Test function for localStorage session persistence
export function testSessionPersistence(): {
  localStorage: boolean;
  currentSession: string | null;
  canStore: boolean;
  canRetrieve: boolean;
  testResult: 'pass' | 'fail' | 'no-storage';
  details: string[];
} {
  const details: string[] = [];
  const testKey = 'ble-mock-test-session';
  const testValue = `test-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
  
  // Check localStorage availability
  const hasLocalStorage = typeof localStorage !== 'undefined';
  details.push(`localStorage available: ${hasLocalStorage}`);
  
  if (!hasLocalStorage) {
    return {
      localStorage: false,
      currentSession: null,
      canStore: false,
      canRetrieve: false,
      testResult: 'no-storage',
      details
    };
  }
  
  // Get current session
  const currentSession = localStorage.getItem('ble-mock-session-id');
  details.push(`Current session: ${currentSession || 'none'}`);
  
  // Test storage
  let canStore = false;
  try {
    localStorage.setItem(testKey, testValue);
    canStore = true;
    details.push('✅ Can write to localStorage');
  } catch (e) {
    details.push(`❌ Cannot write to localStorage: ${e instanceof Error ? e.message : String(e)}`);
  }
  
  // Test retrieval
  let canRetrieve = false;
  if (canStore) {
    try {
      const retrieved = localStorage.getItem(testKey);
      canRetrieve = retrieved === testValue;
      details.push(`✅ Can read from localStorage: ${canRetrieve}`);
      
      // Clean up test key
      localStorage.removeItem(testKey);
    } catch (e) {
      details.push(`❌ Cannot read from localStorage: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  
  const testResult = canStore && canRetrieve ? 'pass' : 'fail';
  
  return {
    localStorage: hasLocalStorage,
    currentSession,
    canStore,
    canRetrieve,
    testResult,
    details
  };
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