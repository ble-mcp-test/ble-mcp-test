// Browser entry point that explicitly exports what we need
import { MockBluetooth, injectWebBluetoothMock, updateMockConfig, getBundleVersion } from './mock-bluetooth.js';

// Export as a global object with the functions we need
export const WebBleMock = {
  MockBluetooth,
  injectWebBluetoothMock,
  updateMockConfig,
  getBundleVersion,
  // Version will be replaced at build time by build script
  version: typeof __PACKAGE_VERSION__ !== 'undefined' ? __PACKAGE_VERSION__ : 'dev'
};

// Also export individually for ES modules
export { MockBluetooth, injectWebBluetoothMock, updateMockConfig, getBundleVersion };

// For IIFE builds, ensure global is set
if (typeof window !== 'undefined') {
  (window as any).WebBleMock = WebBleMock;
}