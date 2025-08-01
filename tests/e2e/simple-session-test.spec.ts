import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('session persistence across reload', async ({ page }) => {
  const bundlePath = join(__dirname, '../../dist/web-ble-mock.bundle.js');
  
  // First page load - use HTTP to enable localStorage
  await page.goto('http://localhost:8888/examples/minimal-session-repro.html');
  
  // Capture all console logs
  const consoleLogs: string[] = [];
  page.on('console', msg => {
    const text = msg.text();
    consoleLogs.push(text);
    console.log(`[Browser] ${text}`);
  });
  
  // First injection
  const firstSession = await page.evaluate(() => {
    window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
    const bluetooth = (navigator as any).bluetooth;
    return {
      autoSessionId: bluetooth.autoSessionId,
      stored: localStorage.getItem('ble-mock-session-id')
    };
  });
  
  console.log('First injection:', firstSession);
  
  // Connect and capture WebSocket URL
  const firstConnection = await page.evaluate(async () => {
    let capturedUrl = '';
    
    // Override WebSocket to capture URL
    const OriginalWebSocket = WebSocket;
    (window as any).WebSocket = class extends OriginalWebSocket {
      constructor(url: string, ...args: any[]) {
        capturedUrl = url;
        super(url, ...args);
      }
    };
    
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'CS108' }]
      });
      await device.gatt.connect();
      return { success: true, url: capturedUrl };
    } catch (error: any) {
      return { success: false, error: error.message, url: capturedUrl };
    }
  });
  
  console.log('First connection:', firstConnection);
  
  // Extract session from URL
  const firstUrlSession = new URL(firstConnection.url).searchParams.get('session');
  console.log('First WebSocket session:', firstUrlSession);
  
  // Reload page
  console.log('\n--- Reloading page ---\n');
  await page.reload();
  
  // Re-inject bundle after reload
  await page.addScriptTag({ path: bundlePath });
  
  // Second injection
  const secondSession = await page.evaluate(() => {
    window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
    const bluetooth = (navigator as any).bluetooth;
    return {
      autoSessionId: bluetooth.autoSessionId,
      stored: localStorage.getItem('ble-mock-session-id')
    };
  });
  
  console.log('Second injection:', secondSession);
  
  // Connect again and capture WebSocket URL
  const secondConnection = await page.evaluate(async () => {
    let capturedUrl = '';
    
    // Override WebSocket to capture URL
    const OriginalWebSocket = WebSocket;
    (window as any).WebSocket = class extends OriginalWebSocket {
      constructor(url: string, ...args: any[]) {
        capturedUrl = url;
        super(url, ...args);
      }
    };
    
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'CS108' }]
      });
      await device.gatt.connect();
      return { success: true, url: capturedUrl };
    } catch (error: any) {
      return { success: false, error: error.message, url: capturedUrl };
    }
  });
  
  console.log('Second connection:', secondConnection);
  
  // Extract session from URL
  const secondUrlSession = new URL(secondConnection.url).searchParams.get('session');
  console.log('Second WebSocket session:', secondUrlSession);
  
  // Analysis
  console.log('\n=== Session Persistence Analysis ===');
  console.log('First session ID:', firstSession.autoSessionId);
  console.log('Second session ID:', secondSession.autoSessionId);
  console.log('First WebSocket session:', firstUrlSession);
  console.log('Second WebSocket session:', secondUrlSession);
  console.log('Sessions match?', firstUrlSession === secondUrlSession);
  
  // Check if we found the bug
  const foundBug = firstSession.autoSessionId === secondSession.autoSessionId && 
                   firstUrlSession !== secondUrlSession;
  
  if (foundBug) {
    console.log('\n🐛 BUG REPRODUCED!');
    console.log('localStorage shows session reused but WebSocket uses different session!');
  } else {
    console.log('\n✅ Session persistence working correctly');
  }
  
  // Assertions
  expect(firstSession.autoSessionId).toBe(secondSession.autoSessionId);
  expect(firstUrlSession).toBe(secondUrlSession);
});