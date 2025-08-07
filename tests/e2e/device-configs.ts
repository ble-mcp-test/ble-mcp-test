/**
 * Device-specific configurations for E2E tests
 * 
 * The bridge is device-agnostic in v0.6.0+, but tests need to know
 * what service UUIDs to request for different devices.
 */

export interface DeviceConfig {
  name: string;
  serviceUuid: string;
  writeUuid: string;
  notifyUuid: string;
  filters: any[]; // Web Bluetooth requestDevice filters
}

// CS108 RFID Reader
export const CS108_CONFIG: DeviceConfig = {
  name: 'CS108',
  serviceUuid: '9800',
  writeUuid: '9900',
  notifyUuid: '9901',
  filters: [
    { 
      namePrefix: 'CS108',
      services: ['9800']
    }
  ]
};

// Generic Battery Service Device
export const BATTERY_DEVICE_CONFIG: DeviceConfig = {
  name: 'Battery Device',
  serviceUuid: '180f', // Battery Service
  writeUuid: '2a19',   // Battery Level
  notifyUuid: '2a19',  // Battery Level
  filters: [
    {
      services: ['180f']
    }
  ]
};

// nRF52 Development Kit
export const NRF52_CONFIG: DeviceConfig = {
  name: 'nRF52',
  serviceUuid: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART Service
  writeUuid: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',   // RX Characteristic
  notifyUuid: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',  // TX Characteristic
  filters: [
    {
      namePrefix: 'nRF52',
      services: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e']
    }
  ]
};

/**
 * Get device configuration based on test requirements
 * Defaults to CS108 for backward compatibility
 */
export function getTestDeviceConfig(): DeviceConfig {
  // Could read from env var or test parameter in future
  // For now, default to CS108
  return CS108_CONFIG;
}