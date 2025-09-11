## FEATURE:

Simplify and fix NodeBleClient API to match browser mock consistency and eliminate unnecessary Web Bluetooth API emulation. The current NodeBleClient forces users through a multi-step connection process when the bridge server already does full BLE connection during WebSocket handshake.

**Success Criteria:**
- NodeBleClient uses service-UUID based discovery (not device name)
- sessionId is required (consistent with browser mock)
- Single `connect()` call establishes full BLE connection (no requestDevice() needed)
- Integration test validates NodeBleClient → Bridge → Hardware communication path
- API is simpler and more Node.js appropriate than Web Bluetooth emulation
- Tests pass before npm publish (prevents broken releases)

## EXAMPLES:

**Current broken pattern in examples/node-client-example.js:**
```javascript
const client = new NodeBleClient({
  bridgeUrl: 'ws://localhost:8080',
  device: process.env.BLE_DEVICE || 'CS108', // WRONG: name-based discovery
  service: process.env.BLE_SERVICE || '9800',
  write: process.env.BLE_WRITE || '9900', 
  notify: process.env.BLE_NOTIFY || '9901',
  debug: true
});

await client.connect();                    // Only connects WebSocket
const device = await client.requestDevice(); // Unnecessary step
await device.gatt.connect();              // No-op facade
```

**Desired simplified pattern:**
```javascript
const client = new NodeBleClient({
  sessionId: 'test-session-' + process.env.USER, // REQUIRED
  bridgeUrl: 'ws://localhost:8080',
  service: '9800',  // Service UUID for discovery (primary method)
  write: '9900',
  notify: '9901',
  // Optional device filtering for multi-device environments:
  deviceId: process.env.BLE_DEVICE_ID,     // Exact device ID
  deviceName: process.env.BLE_DEVICE_NAME, // Partial name match
  debug: true
});

await client.connect(); // WebSocket + full BLE connection in one call
// client.writeValue(data) and client.onNotification() ready to use
```

**Browser mock consistency pattern from src/mock-bluetooth.ts lines 585-595:**
```javascript
if (!config.sessionId) {
  throw new Error('sessionId is required - this prevents session conflicts and ensures predictable BLE connection management');
}
```

**Noble transport service discovery from src/noble-transport.ts lines 140-147:**
```javascript
if (this.config.deviceId) {
  deviceMatch = address ? address.toLowerCase() === this.config.deviceId.toLowerCase() : false;
if (this.config.deviceName) {
  deviceMatch = name.toLowerCase().includes(this.config.deviceName.toLowerCase());
}
// If neither specified, any device with the service matches
```

**Integration test pattern with shared helpers:**
```javascript
import { testCommandHelper } from '../e2e/playwright-test-helpers';

test('NodeBleClient integration test', async () => {
  const client = new NodeBleClient(config);
  await client.connect();
  
  // Use shared test helpers from e2e
  const result = await testCommandHelper({
    writeValue: (data) => client.writeValue(data),
    onNotification: (handler) => client.onNotification(handler),
    command: TEST_COMMAND_BYTES,
    validate: TEST_RESPONSE_VALIDATION
  });
});
```

## DOCUMENTATION:

**Internal codebase references:**
- Current NodeBleClient implementation: `src/node/NodeBleClient.ts`
- Bridge server WebSocket handling: `src/bridge-server.ts` lines 68-89
- Noble transport discovery logic: `src/noble-transport.ts` lines 115-166
- Browser mock validation: `src/mock-bluetooth.ts` lines 585-600
- Session management: `src/session-manager.ts`
- Integration test patterns: `tests/e2e/` directory
- Node client example: `examples/node-client-example.js`

**External documentation:**
- WebSocket URL parameters: Current implementation in bridge-server.ts
- Session management architecture: CLAUDE.md lines 509-536

**Test infrastructure:**
- Vitest for unit tests: `tests/unit/`
- Integration test setup: `tests/integration/`
- Shared E2E helpers: `examples/playwright-test-helpers.ts` with testCommandHelper function
- E2E test constants: TEST_COMMAND_BYTES and TEST_RESPONSE_VALIDATION

## OTHER CONSIDERATIONS:

**Critical constraints:**
- MUST use pnpm (never npm/npx/yarn) - see CLAUDE.md
- MUST follow "DELETE don't deprecate" principle - remove old patterns
- MUST validate with integration test before npm publish
- MUST maintain Noble transport atomicity (don't break session reuse)
- MUST be consistent with browser mock session handling

**Noble.js quirks and gotchas:**
- Device names often show as "Unknown" on Linux - don't rely on names
- Service-UUID filtering works reliably across platforms
- Multiple peripheral objects for same device cause subscription accumulation
- Bridge server handles all async operations - client should be mostly synchronous after connect

**Integration test requirements:**
- Test must validate end-to-end: NodeBleClient → Bridge → Noble → Hardware
- Should test both service-only discovery and optional device filtering  
- Must validate session reuse doesn't cause characteristic staleness
- Should test error handling (hardware not found, bridge not running)
- Must run in CI without hardware (mock or timeout gracefully)
- MUST reuse testCommandHelper from examples/playwright-test-helpers.ts
- MUST import TEST_COMMAND_BYTES and TEST_RESPONSE_VALIDATION constants

**API design principles:**
- Simple Node.js API (no Web Bluetooth emulation)
- Make required parameters explicit (fail fast on missing config)
- Reduce async ceremony where bridge has already done the work
- Provide direct writeValue/onNotification methods

**Performance considerations:**
- Connect should be single WebSocket round-trip + BLE discovery
- No unnecessary async operations after connection established
- Session reuse should work efficiently for repeated test runs
- Memory usage should be constant (no leaks from facade objects)

**Testing strategy:**
- Unit tests for NodeBleClient class methods and error handling
- Integration test with real bridge server (no hardware required)
- E2E test with hardware in CI (or graceful skip if unavailable)
- Validation gates: lint, typecheck, unit tests, integration tests
- Must pass all validation before version bump or npm publish

**Error handling:**
- Clear error messages for missing required parameters
- Helpful error for bridge server not running
- Timeout handling for hardware discovery
- Session conflict detection and guidance
- WebSocket connection failure recovery

**Documentation updates:**
- Update examples/node-client-example.js to show new API
- Update docs/API.md NodeBleClient section  
- Update examples/README.md with new patterns
- Update CHANGELOG.md with breaking changes
- Bump package.json to next patch version (0.7.3)