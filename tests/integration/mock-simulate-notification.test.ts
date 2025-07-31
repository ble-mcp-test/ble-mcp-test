import { describe, it, expect } from 'vitest';
import { MockBluetooth } from '../../src/mock-bluetooth.js';
import { BridgeServer } from '../../src/index.js';
import { SharedState } from '../../src/shared-state.js';
import { getDeviceConfig } from '../test-config.js';

const DEVICE_CONFIG = getDeviceConfig();

/**
 * Test the mock's simulateNotification feature for injecting test data
 */
describe('Mock Simulate Notification', () => {
  let server: BridgeServer;
  const port = 8087;
  
  beforeAll(async () => {
    const sharedState = new SharedState(false);
    server = new BridgeServer('info', sharedState);
    await server.start(port);
  });
  
  afterAll(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('should simulate device notifications for testing', async () => {
    console.log('\n📨 Testing simulateNotification feature\n');
    
    // Create mock and connect
    const mock = new MockBluetooth(`ws://localhost:${port}`, DEVICE_CONFIG);
    const device = await mock.requestDevice({ 
      filters: [{ namePrefix: DEVICE_CONFIG.device }] 
    });
    
    await device.gatt.connect();
    const service = await device.gatt.getPrimaryService(DEVICE_CONFIG.service);
    const notifyChar = await service.getCharacteristic(DEVICE_CONFIG.notify);
    
    // Set up notification handler to capture events
    const receivedData: Uint8Array[] = [];
    await notifyChar.startNotifications();
    
    notifyChar.addEventListener('characteristicvaluechanged', (event: any) => {
      const data = new Uint8Array(event.target.value.buffer);
      receivedData.push(data);
      
      const hex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`  Received notification: ${hex}`);
    });
    
    console.log('  🔬 Simulating button press event...');
    // Simulate button press (example packet format)
    notifyChar.simulateNotification(new Uint8Array([0xA7, 0xB3, 0x04, 0x01, 0xFF, 0x00, 0x00]));
    
    // Allow event to process
    await new Promise(resolve => setTimeout(resolve, 10));
    
    console.log('  🔬 Simulating button release event...');
    // Simulate button release
    notifyChar.simulateNotification(new Uint8Array([0xA7, 0xB3, 0x04, 0x01, 0x00, 0x00, 0x00]));
    
    // Allow event to process
    await new Promise(resolve => setTimeout(resolve, 10));
    
    console.log('  🔬 Simulating sensor reading...');
    // Simulate sensor reading (temperature: 25.5°C)
    notifyChar.simulateNotification(new Uint8Array([0xA7, 0xB3, 0x06, 0x02, 0xFF, 0x00, 0x00, 0x00]));
    
    // Allow event to process
    await new Promise(resolve => setTimeout(resolve, 10));
    
    // Verify we received all simulated notifications
    expect(receivedData.length).toBe(3);
    expect(receivedData[0][4]).toBe(0xFF); // Button pressed
    expect(receivedData[1][4]).toBe(0x00); // Button released
    expect(receivedData[2][3]).toBe(0x02); // Sensor type
    
    console.log(`\n  ✅ Successfully received ${receivedData.length} simulated notifications`);
    
    // Clean up
    await device.gatt.disconnect();
  });

  it('should throw error when trying to simulate while disconnected', async () => {
    console.log('\n⛔ Testing error handling for simulateNotification\n');
    
    const mock = new MockBluetooth(`ws://localhost:${port}`, DEVICE_CONFIG);
    const device = await mock.requestDevice({ 
      filters: [{ namePrefix: DEVICE_CONFIG.device }] 
    });
    
    // Connect and get characteristic
    await device.gatt.connect();
    const service = await device.gatt.getPrimaryService(DEVICE_CONFIG.service);
    const notifyChar = await service.getCharacteristic(DEVICE_CONFIG.notify);
    
    // Disconnect
    await device.gatt.disconnect();
    
    // Try to simulate - should throw
    expect(() => {
      notifyChar.simulateNotification(new Uint8Array([0x01, 0x02, 0x03]));
    }).toThrow('GATT Server not connected');
    
    console.log('  ✅ Correctly threw error when disconnected');
  });
  
  it('should handle mixed real and simulated notifications', async () => {
    console.log('\n🌀 Testing mixed real and simulated notifications\n');
    
    const mock = new MockBluetooth(`ws://localhost:${port}`, DEVICE_CONFIG);
    const device = await mock.requestDevice({ 
      filters: [{ namePrefix: DEVICE_CONFIG.device }] 
    });
    
    await device.gatt.connect();
    const service = await device.gatt.getPrimaryService(DEVICE_CONFIG.service);
    const writeChar = await service.getCharacteristic(DEVICE_CONFIG.write);
    const notifyChar = await service.getCharacteristic(DEVICE_CONFIG.notify);
    
    const notifications: { source: string; data: Uint8Array }[] = [];
    await notifyChar.startNotifications();
    
    notifyChar.addEventListener('characteristicvaluechanged', (event: any) => {
      const data = new Uint8Array(event.target.value.buffer);
      // Determine source based on data pattern
      const source = data[0] === 0xFF ? 'simulated' : 'real';
      notifications.push({ source, data });
    });
    
    // Send real command (if device is available)
    console.log('  Sending real command to device...');
    try {
      await writeChar.writeValue(new Uint8Array([0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00]));
      // Wait for real response
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (e) {
      console.log('  (Device not available, skipping real command)');
    }
    
    // Inject simulated notification
    console.log('  Injecting simulated notification...');
    notifyChar.simulateNotification(new Uint8Array([0xFF, 0xAA, 0xBB, 0xCC]));
    
    await new Promise(resolve => setTimeout(resolve, 50));
    
    console.log(`\n  Received ${notifications.length} notifications:`);
    notifications.forEach((n, i) => {
      const hex = Array.from(n.data).map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`    ${i + 1}. ${n.source}: ${hex}`);
    });
    
    // At least the simulated one should be there
    const simulated = notifications.filter(n => n.source === 'simulated');
    expect(simulated.length).toBeGreaterThanOrEqual(1);
    
    await device.gatt.disconnect();
  });
});