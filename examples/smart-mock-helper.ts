/**
 * Smart mock injection helper that works in both dev and CI modes
 * Automatically detects and handles three scenarios:
 * 1. Dev server with pre-injected mock - uses existing mock
 * 2. CI with bundle loaded - injects mock
 * 3. CI without bundle - loads bundle then injects mock
 */

import { Page } from '@playwright/test';
import * as path from 'path';
import os from 'os';

export interface SmartMockConfig {
  // Optional custom config - defaults to standard CS108 config
  sessionId?: string;
  serverUrl?: string;
  service?: string;
  write?: string;
  notify?: string;
}

/**
 * Ensures mock is available and injected, regardless of environment
 * 
 * @param page - Playwright page
 * @param config - Optional custom configuration
 * @returns Information about what action was taken
 */
export async function ensureMockInjected(
  page: Page,
  config?: SmartMockConfig
): Promise<{ mode: 'dev' | 'ci-inject' | 'ci-load'; sessionId: string }> {
  // Default configuration
  const defaultConfig = {
    sessionId: config?.sessionId || `e2e-test-${os.hostname()}`,
    serverUrl: config?.serverUrl || process.env.BLE_BRIDGE_URL || 'ws://localhost:8080',
    service: config?.service || process.env.BLE_MCP_SERVICE_UUID || '9800',
    write: config?.write || process.env.BLE_MCP_WRITE_UUID || '9900',
    notify: config?.notify || process.env.BLE_MCP_NOTIFY_UUID || '9901'
  };

  // Check current mock status
  const mockStatus = await page.evaluate(() => {
    return {
      hasMock: typeof (window as any).WebBleMock !== 'undefined',
      isInjected: (window as any).__webBluetoothMocked === true,
      hasNavigatorBluetooth: 'bluetooth' in navigator,
      sessionId: (window as any).__bleSessionId || null
    };
  });

  // Scenario 1: Already injected by dev server
  if (mockStatus.isInjected) {
    console.log('[Mock] Using pre-injected mock from dev server');
    return { 
      mode: 'dev', 
      sessionId: mockStatus.sessionId || 'dev-session' 
    };
  }

  // Scenario 2: Mock available but not injected (CI with bundle)
  if (mockStatus.hasMock && !mockStatus.isInjected) {
    console.log('[Mock] Injecting mock for CI mode');
    
    await page.evaluate((cfg) => {
      (window as any).WebBleMock.injectWebBluetoothMock(cfg);
      (window as any).__webBluetoothMocked = true;
      (window as any).__bleSessionId = cfg.sessionId;
    }, defaultConfig);
    
    return { 
      mode: 'ci-inject', 
      sessionId: defaultConfig.sessionId 
    };
  }

  // Scenario 3: No mock at all (CI without bundle)
  if (!mockStatus.hasMock) {
    console.log('[Mock] Loading bundle and injecting mock for CI mode');
    
    // Try to load bundle from various locations
    const bundlePaths = [
      path.join(process.cwd(), 'node_modules/ble-mcp-test/dist/web-ble-mock.bundle.js'),
      path.join(__dirname, '../dist/web-ble-mock.bundle.js'),
      path.join(__dirname, '../../dist/web-ble-mock.bundle.js')
    ];
    
    let loaded = false;
    for (const bundlePath of bundlePaths) {
      try {
        await page.addScriptTag({ path: bundlePath });
        loaded = true;
        console.log(`[Mock] Bundle loaded from: ${bundlePath}`);
        break;
      } catch {
        // Try next path
      }
    }
    
    if (!loaded) {
      // Last resort: load from URL if available
      try {
        await page.addScriptTag({ url: '/web-ble-mock.bundle.js' });
        loaded = true;
        console.log('[Mock] Bundle loaded from URL');
      } catch {
        throw new Error('Could not load mock bundle from any location');
      }
    }
    
    // Now inject
    await page.evaluate((cfg) => {
      (window as any).WebBleMock.injectWebBluetoothMock(cfg);
      (window as any).__webBluetoothMocked = true;
      (window as any).__bleSessionId = cfg.sessionId;
    }, defaultConfig);
    
    return { 
      mode: 'ci-load', 
      sessionId: defaultConfig.sessionId 
    };
  }
  
  throw new Error('Unexpected mock state');
}

/**
 * Verify mock is properly configured and ready
 */
export async function verifyMockReady(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // Check all requirements
    const hasNavigatorBluetooth = 'bluetooth' in navigator;
    const hasRequestDevice = navigator.bluetooth && 
                            typeof navigator.bluetooth.requestDevice === 'function';
    const isMocked = (window as any).__webBluetoothMocked === true;
    
    return hasNavigatorBluetooth && hasRequestDevice && isMocked;
  });
}

/**
 * Get information about the current mock configuration
 */
export async function getMockInfo(page: Page): Promise<{
  injected: boolean;
  sessionId: string | null;
  version: string | null;
  mode: string | null;
}> {
  return page.evaluate(() => {
    const mock = (window as any).WebBleMock;
    return {
      injected: (window as any).__webBluetoothMocked === true,
      sessionId: (window as any).__bleSessionId || mock?.getSessionId?.() || null,
      version: mock?.version || null,
      mode: (window as any).__bleMockMode || null
    };
  });
}

/**
 * Example usage in a test
 */
export async function exampleTestSetup(page: Page) {
  // Navigate to your app
  await page.goto('http://localhost:5173');
  
  // Ensure mock is injected (works in both dev and CI)
  const { mode, sessionId } = await ensureMockInjected(page);
  console.log(`[Test] Mock ready in ${mode} mode with session: ${sessionId}`);
  
  // Verify it's working
  const ready = await verifyMockReady(page);
  if (!ready) {
    throw new Error('Mock not properly configured');
  }
  
  // Get mock info for debugging
  const info = await getMockInfo(page);
  console.log('[Test] Mock info:', info);
  
  // Now your test can proceed
  return { mode, sessionId };
}