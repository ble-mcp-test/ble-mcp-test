// Browser entry point that explicitly exports what we need
import { MockBluetooth, injectWebBluetoothMock, updateMockConfig, clearStoredSession, setTestSessionId, testSessionPersistence, getBundleVersion } from './mock-bluetooth.js';

// Export as a global object with the functions we need
export const WebBleMock = {
  MockBluetooth,
  injectWebBluetoothMock,
  updateMockConfig,
  clearStoredSession,
  setTestSessionId,
  testSessionPersistence,
  getBundleVersion,
  version: '0.5.5' // Bundle version for cache-busting verification
};

// Also export individually for ES modules
export { MockBluetooth, injectWebBluetoothMock, updateMockConfig, clearStoredSession, setTestSessionId, testSessionPersistence, getBundleVersion };

// For IIFE builds, ensure global is set
if (typeof window !== 'undefined') {
  (window as any).WebBleMock = WebBleMock;
}