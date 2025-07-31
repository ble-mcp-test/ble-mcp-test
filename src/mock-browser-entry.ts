// Browser entry point that explicitly exports what we need
import { MockBluetooth, injectWebBluetoothMock, updateMockConfig } from './mock-bluetooth.js';

// Export as a global object with the functions we need
export const WebBleMock = {
  MockBluetooth,
  injectWebBluetoothMock,
  updateMockConfig
};

// Also export individually for ES modules
export { MockBluetooth, injectWebBluetoothMock, updateMockConfig };

// For IIFE builds, ensure global is set
if (typeof window !== 'undefined') {
  (window as any).WebBleMock = WebBleMock;
}