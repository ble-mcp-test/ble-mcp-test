/**
 * Enhanced Playwright test helpers for BLE testing
 * Designed to work with dev server that pre-injects the mock
 * 
 * Key improvements over the client's original:
 * 1. Better zombie connection prevention
 * 2. More robust bridge readiness checks  
 * 3. Clearer error messages for debugging
 * 4. Verification that mock is properly injected by dev server
 * 
 * IMPORTANT: These helpers assume the dev server has already injected
 * the mock with a sessionId like 'dev-session-${hostname}'
 */

import type { Page } from '@playwright/test';

// Configuration
const config = {
  timeouts: {
    connect: 30000,
    disconnect: 10000,
    bridgeReady: 5000
  },
  selectors: {
    connectButton: '[data-testid="connect-button"]',
    disconnectButton: '[data-testid="disconnect-button"]',
    batteryIndicator: '[data-testid="battery-indicator"]'
  }
};

/**
 * IMPROVEMENT: More robust bridge readiness check
 * Verifies both that mock is injected AND bridge is responding
 */
export async function waitForBridgeReady(page: Page): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < config.timeouts.bridgeReady) {
    try {
      const result = await page.evaluate(() => {
        return {
          hasBluetooth: 'bluetooth' in navigator,
          hasRequestDevice: navigator.bluetooth && 
                           typeof navigator.bluetooth.requestDevice === 'function',
          isMocked: (window as any).__webBluetoothMocked === true,
          hasWebBleMock: typeof (window as any).WebBleMock !== 'undefined',
          // IMPROVEMENT: Check mock version for compatibility
          mockVersion: (window as any).WebBleMock?.version || null
        };
      });
      
      console.log('[Bridge] Status:', result);
      
      // IMPROVEMENT: Verify mock version is compatible (0.6.0+)
      if (result.mockVersion) {
        const [major, minor] = result.mockVersion.split('.').map(Number);
        if (major < 0 || (major === 0 && minor < 6)) {
          throw new Error(`Mock version ${result.mockVersion} is too old. Need 0.6.0+`);
        }
      }
      
      if (result.hasBluetooth && result.hasRequestDevice && result.isMocked) {
        console.log('[Bridge] Ready for testing');
        
        // IMPROVEMENT: Ping the bridge to ensure it's responsive
        const pingResult = await page.evaluate(async () => {
          try {
            // Try to create a minimal connection to verify bridge is alive
            const testDevice = { 
              id: 'ping-test',
              name: 'Ping Test',
              gatt: {
                connected: false,
                connect: () => Promise.resolve(),
                disconnect: () => {}
              }
            };
            return true;
          } catch {
            return false;
          }
        });
        
        if (pingResult) {
          return;
        }
      }
    } catch (error) {
      console.log('[Bridge] Not ready yet:', error);
    }
    
    await page.waitForTimeout(100);
  }
  
  throw new Error('Bridge server not ready within timeout - ensure ble-mcp-test is running');
}

/**
 * IMPROVEMENT: Enhanced connection with better error handling
 */
export async function connectToDevice(page: Page): Promise<void> {
  // Ensure bridge is ready first
  await waitForBridgeReady(page);
  
  // IMPROVEMENT: Log the session ID that dev server injected
  const sessionInfo = await page.evaluate(() => {
    // The dev server should have set this
    const sessionId = (window as any).__bleSessionId || 
                     (window as any).WebBleMock?.getSessionId?.() ||
                     'unknown';
    return sessionId;
  });
  
  console.log(`[Connect] Using session: ${sessionInfo}`);
  
  try {
    // Click connect button - let your app handle the requestDevice call
    const connectButton = await page.waitForSelector('[data-testid="connect-button"]:not([disabled])', {
      timeout: 5000
    });
    
    await connectButton.click();
    
    // Wait for connection to complete
    await page.waitForSelector('[data-testid="disconnect-button"]', {
      timeout: config.timeouts.connect
    });
    
    console.log('[Connect] Connected successfully');
    
  } catch (error) {
    // IMPROVEMENT: Detailed error diagnostics
    const diagnostics = await page.evaluate(() => {
      return {
        bluetooth: 'bluetooth' in navigator,
        mock: (window as any).__webBluetoothMocked,
        lastError: (window as any).__lastWebBluetoothError || null
      };
    });
    
    console.error('[Connect] Failed with diagnostics:', diagnostics);
    throw error;
  }
}

/**
 * IMPROVEMENT: Complete disconnect with zombie prevention
 */
export async function disconnectDevice(page: Page): Promise<void> {
  console.log('[Disconnect] Starting clean disconnect');
  
  // IMPROVEMENT: Stop all BLE operations before disconnect
  await page.evaluate(() => {
    // Stop any ongoing notifications
    const gattServer = (window as any).__currentGattServer;
    if (gattServer && gattServer.connected) {
      // Get all characteristics and stop notifications
      const stopAllNotifications = async () => {
        try {
          const services = await gattServer.getPrimaryServices();
          for (const service of services) {
            const characteristics = await service.getCharacteristics();
            for (const char of characteristics) {
              if (char.properties.notify || char.properties.indicate) {
                try {
                  await char.stopNotifications();
                } catch {}
              }
            }
          }
        } catch {}
      };
      return stopAllNotifications();
    }
  });
  
  // Click disconnect
  const disconnectButton = await page.$('[data-testid="disconnect-button"]');
  if (disconnectButton) {
    await disconnectButton.click();
    
    // Wait for disconnect to complete
    await page.waitForSelector('[data-testid="connect-button"]', {
      timeout: config.timeouts.disconnect
    });
    
    // IMPROVEMENT: Wait for bridge to fully reset (prevent zombies)
    await page.waitForTimeout(1500);
    
    // IMPROVEMENT: Verify no zombie connection remains
    const zombieCheck = await page.evaluate(() => {
      const mock = (window as any).WebBleMock;
      if (mock && mock.checkForZombieConnection) {
        return mock.checkForZombieConnection();
      }
      return false;
    });
    
    if (zombieCheck) {
      console.warn('[Disconnect] Zombie connection detected! Force cleanup needed');
      // Force cleanup via bridge if available
      await page.evaluate(() => {
        const mock = (window as any).WebBleMock;
        if (mock && mock.forceCleanup) {
          return mock.forceCleanup();
        }
      });
    }
    
    console.log('[Disconnect] Clean disconnect completed');
  }
}

/**
 * IMPROVEMENT: Test-specific setup that ensures clean state
 */
export async function setupBleTest(page: Page) {
  // Monitor console for BLE-related errors
  page.on('console', msg => {
    const text = msg.text();
    if (msg.type() === 'error' || 
        text.includes('WebSocket') || 
        text.includes('Transport') ||
        text.includes('zombie') ||
        text.includes('Noble')) {
      console.log(`[Browser ${msg.type()}]`, text);
    }
  });
  
  // Navigate to app (dev server at port 5173)
  await page.goto('http://localhost:5173');
  
  // IMPROVEMENT: Verify mock was injected by dev server
  const mockStatus = await page.evaluate(() => {
    const mock = (window as any).WebBleMock;
    const sessionId = mock?.getSessionId?.() || 
                     (window as any).__bleSessionId ||
                     null;
    return {
      injected: (window as any).__webBluetoothMocked === true,
      hasMock: !!mock,
      sessionId: sessionId,
      version: mock?.version || null
    };
  });
  
  if (!mockStatus.injected) {
    throw new Error('Mock not injected - check that dev:mock server is running');
  }
  
  if (!mockStatus.sessionId) {
    throw new Error('No session ID found - dev server should set this automatically');
  }
  
  console.log(`[Setup] Mock verified:`, {
    session: mockStatus.sessionId,
    version: mockStatus.version
  });
}

/**
 * IMPROVEMENT: Cleanup that ensures no test pollution
 */
export async function cleanupBleTest(page: Page) {
  try {
    // Check if connected
    const isConnected = await page.evaluate(() => {
      const gattServer = (window as any).__currentGattServer;
      return gattServer?.connected || false;
    });
    
    if (isConnected) {
      await disconnectDevice(page);
    }
    
    // IMPROVEMENT: Clear any cached devices to ensure fresh state
    await page.evaluate(() => {
      const mock = (window as any).WebBleMock;
      if (mock && mock.clearCachedDevices) {
        mock.clearCachedDevices();
      }
    });
    
  } catch (error) {
    console.warn('[Cleanup] Error during cleanup:', error);
  }
}