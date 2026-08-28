/**
 * The `.` entry point: this package's Web Bluetooth implementation, importable.
 *
 * ## Why there are two entry points and one implementation
 *
 * The axis is **import vs inject**, not browser vs node. `mock-bluetooth.ts` is
 * runtime-agnostic -- `window` appears nowhere in `MockBluetooth`, `MockGATT`,
 * `MockService` or `MockCharacteristic`, only inside `injectWebBluetoothMock`,
 * whose entire job is putting the mock onto a page's navigator. The transport
 * uses the global `WebSocket`, native in browsers and in Node 22+; this package's
 * floor is Node 24.
 *
 * So the only thing that differs between packagings is how the implementation
 * reaches a global, and:
 *
 * - `.` (this file) is for anything that can `import` -- vitest, plain Node, a
 *   bundler. It hands you the classes; where they go is your business.
 * - `./browser` is the esbuild IIFE. It stays because Playwright's
 *   `addInitScript` and platform's vite `transformIndexHtml` genuinely cannot
 *   import -- a real constraint, not a compatibility concession.
 *
 * Naming this `.` rather than `./mock` is deliberate. `./mock` names the
 * test-double-ness; under a fidelity goal, what this package's default export
 * IS is a Web Bluetooth implementation, and the name should say what it
 * implements. `.` was removed in 0.8.0 because its CONTENTS died -- it
 * re-exported BridgeServer, NobleTransport and the MCP server, all deleted --
 * not because a root entry was wrong.
 *
 * There is no third packaging. `./node` was one until 0.9.0: a separate,
 * hand-written GATT chain that nothing had ever driven -- no `requestDevice` on
 * `NodeBleClient` in any version published or unpublished, nothing constructing
 * a `NodeBleDevice`, every inbound frame routed to one flat handler so
 * `device.handleNotification` was never called. A hand-built device there
 * connected, resolved a service, resolved a characteristic, returned from
 * `startNotifications()` -- and then never fired an event. It was deleted by
 * TRA-1187 item 4 once `trakrf/platform` moved off its flat API.
 *
 * The contract every packaging must satisfy is
 * docs/design/2026-08-27-client-contract.md, and tests/conformance/ is what
 * holds them to it.
 */

export {
  MockBluetooth,
  MockBluetoothRemoteGATTCharacteristic,
  injectWebBluetoothMock,
  updateMockConfig,
  resolveMockConfig,
  DEFAULT_MOCK_CONFIG
} from './mock-bluetooth.js';

export type {
  MockConfig,
  WebBleMockConfig,
  BluetoothTesting,
  ReaderState,
  TestCommandOptions,
  TestResult,
  SimulateNotificationOptions,
  TestingUtils
} from './mock-bluetooth.js';

export { WebSocketTransport } from './ws-transport.js';
export type { WSMessage } from './ws-transport.js';

export {
  WEBSOCKET_CLOSE_CODES,
  CLOSE_CODE_MESSAGES,
  BLEConnectionError,
  mapErrorToCloseCode
} from './constants.js';
export type { WebSocketCloseCode } from './constants.js';

export { VERSION } from './version.js';
