/**
 * Direct bridge server test - bypasses UI completely
 * Tests the raw WebSocket connection and protocol flow
 * to isolate whether the issue is in the bridge or our app
 */

import { test, expect } from '@playwright/test';

test.describe('Bridge Server Direct Test', () => {
  test('should complete full connection protocol via WebSocket', async ({ page }) => {
    console.log('[Bridge Test] Starting direct bridge protocol test');
    
    // Inject a direct WebSocket test into the page
    const connectionResult = await page.evaluate(async () => {
      const results: string[] = [];
      let ws: WebSocket | null = null;
      
      try {
        // Connect directly to bridge WebSocket
        results.push('Connecting to WebSocket...');
        ws = new WebSocket('ws://192.168.50.73:8080');
        
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000);
          
          ws!.onopen = () => {
            clearTimeout(timeout);
            results.push('WebSocket connected');
            resolve(void 0);
          };
          
          ws!.onerror = (error) => {
            clearTimeout(timeout);
            results.push(`WebSocket error: ${error}`);
            reject(error);
          };
        });
        
        // Set up message handler
        const messages: any[] = [];
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          messages.push(data);
          results.push(`Received: ${JSON.stringify(data)}`);
        };
        
        // Send session request
        results.push('Sending session request...');
        ws.send(JSON.stringify({
          type: 'session',
          sessionId: 'bridge-test-session'
        }));
        
        // Wait for session response
        await new Promise((resolve) => {
          const checkMessages = () => {
            if (messages.some(msg => msg.type === 'session' && msg.status === 'ready')) {
              results.push('Session established');
              resolve(void 0);
            } else {
              setTimeout(checkMessages, 100);
            }
          };
          checkMessages();
        });
        
        // Send BLE scan request
        results.push('Sending BLE scan request...');
        ws.send(JSON.stringify({
          type: 'scan',
          duration: 2000
        }));
        
        // Wait for scan results
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 3000);
          const checkMessages = () => {
            const scanResult = messages.find(msg => msg.type === 'scan_result');
            if (scanResult) {
              clearTimeout(timeout);
              results.push(`Scan found ${scanResult.devices?.length || 0} devices`);
              resolve(void 0);
            } else {
              setTimeout(checkMessages, 100);
            }
          };
          checkMessages();
        });
        
        // Send connect request for CS108
        results.push('Sending connect request...');
        ws.send(JSON.stringify({
          type: 'connect',
          deviceName: 'CS108 Reader'
        }));
        
        // Wait for connection response
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            results.push('Connection timeout - no response received');
            resolve(void 0);
          }, 10000);
          
          const checkMessages = () => {
            const connectResult = messages.find(msg => msg.type === 'connected');
            if (connectResult) {
              clearTimeout(timeout);
              results.push(`Connected: ${JSON.stringify(connectResult)}`);
              resolve(void 0);
            } else {
              setTimeout(checkMessages, 100);
            }
          };
          checkMessages();
        });
        
        // Send a test command to verify the connection works
        results.push('Sending battery level command...');
        ws.send(JSON.stringify({
          type: 'write',
          data: 'A7B3180000000A0D' // Battery level command
        }));
        
        // Wait for battery response
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            results.push('Battery command timeout');
            resolve(void 0);
          }, 5000);
          
          const checkMessages = () => {
            const batteryResult = messages.find(msg => msg.type === 'notify' && msg.data?.includes('B3A718'));
            if (batteryResult) {
              clearTimeout(timeout);
              results.push(`Battery response: ${batteryResult.data}`);
              resolve(void 0);
            } else {
              setTimeout(checkMessages, 100);
            }
          };
          checkMessages();
        });
        
        return { success: true, results, messages };
        
      } catch (error) {
        results.push(`Error: ${(error as Error).message}`);
        return { success: false, results, error: (error as Error).message };
      } finally {
        if (ws) {
          ws.close();
          results.push('WebSocket closed');
        }
      }
    });
    
    console.log('[Bridge Test] Results:');
    connectionResult.results.forEach(result => {
      console.log(`  ${result}`);
    });
    
    if (!connectionResult.success) {
      console.log('[Bridge Test] Messages received:', connectionResult.messages);
    }
    
    // The test passes if we can establish WebSocket connection
    // Even if BLE parts fail, we want to see what the bridge is actually doing
    expect(connectionResult.results).toContain('WebSocket connected');
  });
  
  test('should test Web Bluetooth mock directly', async ({ page }) => {
    console.log('[Bridge Test] Testing Web Bluetooth mock directly');
    
    // Load the page first to get the mock injected
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    const mockResult = await page.evaluate(async () => {
      const results: string[] = [];
      
      try {
        // Check if Web Bluetooth is available and mocked
        results.push(`Web Bluetooth available: ${!!navigator.bluetooth}`);
        results.push(`Mock injected: ${!!(window as any).__webBluetoothMocked}`);
        
        if (!navigator.bluetooth) {
          return { success: false, results, error: 'Web Bluetooth not available' };
        }
        
        // Try to request device
        results.push('Requesting BLE device...');
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ name: 'CS108 Reader' }],
          optionalServices: ['0000fee0-0000-1000-8000-00805f9b34fb']
        });
        
        results.push(`Device found: ${device.name}`);
        results.push(`Device ID: ${device.id}`);
        results.push(`Device connected: ${device.gatt?.connected}`);
        
        // Try to connect GATT
        results.push('Connecting GATT...');
        if (!device.gatt) {
          throw new Error('GATT not available');
        }
        
        const server = await device.gatt.connect();
        results.push(`GATT connected: ${server.connected}`);
        
        // Try to get service
        results.push('Getting primary service...');
        const service = await server.getPrimaryService('0000fee0-0000-1000-8000-00805f9b34fb');
        results.push(`Service UUID: ${service.uuid}`);
        
        // Try to get characteristics
        results.push('Getting characteristics...');
        const characteristics = await service.getCharacteristics();
        results.push(`Found ${characteristics.length} characteristics`);
        
        characteristics.forEach((char, index) => {
          results.push(`Char ${index}: ${char.uuid}`);
        });
        
        // Try to write a command
        const writeChar = characteristics.find(c => c.properties.write || c.properties.writeWithoutResponse);
        if (writeChar) {
          results.push(`Writing to characteristic: ${writeChar.uuid}`);
          const command = new Uint8Array([0xA7, 0xB3, 0x18, 0x00, 0x00, 0x00, 0x0A, 0x0D]); // Battery command
          await writeChar.writeValue(command);
          results.push('Write successful');
        }
        
        // Try to set up notifications
        const notifyChar = characteristics.find(c => c.properties.notify);
        if (notifyChar) {
          results.push(`Setting up notifications on: ${notifyChar.uuid}`);
          await notifyChar.startNotifications();
          
          notifyChar.addEventListener('characteristicvaluechanged', (event) => {
            const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
            if (value) {
              const hex = Array.from(new Uint8Array(value.buffer))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('').toUpperCase();
              results.push(`Notification: ${hex}`);
            }
          });
          
          results.push('Notifications enabled');
          
          // Wait a bit for potential responses
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        return { success: true, results };
        
      } catch (error) {
        results.push(`Error: ${(error as Error).message}`);
        return { success: false, results, error: (error as Error).message };
      }
    });
    
    console.log('[Bridge Test] Web Bluetooth Mock Results:');
    mockResult.results.forEach(result => {
      console.log(`  ${result}`);
    });
    
    // Test passes if we can at least request a device
    expect(mockResult.results.some(r => r.includes('Device found'))).toBe(true);
  });
});