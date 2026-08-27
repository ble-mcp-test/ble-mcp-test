// Browser entry point that explicitly exports what we need.
//
// This is the INJECT half of the package's real axis. `src/index.ts` is the
// IMPORT half. They are not two implementations -- both import the same
// `mock-bluetooth.ts`; the only thing that differs is how the mock reaches a
// global. See docs/design/2026-08-27-client-contract.md.
import { MockBluetooth, injectWebBluetoothMock, updateMockConfig } from './mock-bluetooth.js';
import { VERSION } from './version.js';

// Export as a global object with the functions we need
export const WebBleMock = {
  MockBluetooth,
  injectWebBluetoothMock,
  updateMockConfig,
  version: VERSION
};

// Also export individually for ES modules
export { MockBluetooth, injectWebBluetoothMock, updateMockConfig, VERSION };

// For IIFE builds, ensure global is set
if (typeof window !== 'undefined') {
  (window as any).WebBleMock = WebBleMock;
}
