# Node.js Transport Implementation PRP

## Goal
Add a Node.js transport client to ble-mcp-test that provides Web Bluetooth API compatibility for Node.js environments, enabling integration testing against real hardware through the bridge server. This will allow Node.js applications to test BLE devices using the same API as browser-based tests.

## Context
This project (ble-mcp-test) is a WebSocket-to-BLE bridge that allows testing real BLE devices in Playwright/E2E tests without browser support. The current implementation provides:
- A WebSocket bridge server (`src/bridge-server.ts`) - requires Node.js 24+ for Noble
- A browser mock implementation (`src/mock-bluetooth.ts`) - works in any browser
- WebSocket transport (`src/ws-transport.ts`)
- Noble BLE transport (`src/noble-transport.ts`) - requires Node.js 24+

The Node.js transport will provide the same Web Bluetooth API interface for Node.js environments, routing through the existing WebSocket bridge. It will work with Node.js 14+ since it only uses WebSocket and EventEmitter.

## Key Implementation Files to Reference

### Current Implementation Patterns
1. **Mock Bluetooth Pattern** (`src/mock-bluetooth.ts`):
   - Lines 44-136: MockBluetoothRemoteGATTCharacteristic implementation
   - Lines 169-301: MockBluetoothRemoteGATTServer with connection retry logic
   - Lines 303-364: MockBluetoothDevice with WebSocketTransport integration
   - Lines 367-586: MockBluetooth main class with session management

2. **WebSocket Transport** (`src/ws-transport.ts`):
   - Lines 18-28: WebSocketTransport class structure
   - Lines 29-103: Connection logic with session management
   - Lines 104-129: Message handling patterns
   - Lines 131-169: Force cleanup implementation

3. **Bridge Protocol Messages** (from specification):
   - Client → Bridge: connect, disconnect, scan, write, read, subscribe, unsubscribe
   - Bridge → Client: connected, disconnected, scan_result, notification, error, ack

## External Documentation References

### WebSocket (ws) Library
- GitHub: https://github.com/websockets/ws
- API Documentation: https://github.com/websockets/ws/blob/master/doc/ws.md
- Best practices: Use EventEmitter patterns, implement heartbeat/keep-alive, handle reconnection

### Web Bluetooth API Compatibility
- MDN BluetoothRemoteGATTCharacteristic: https://developer.mozilla.org/en-US/docs/Web/API/BluetoothRemoteGATTCharacteristic
- MDN startNotifications: https://developer.mozilla.org/en-US/docs/Web/API/BluetoothRemoteGATTCharacteristic/startNotifications
- Chrome implementation guide: https://developer.chrome.com/docs/capabilities/bluetooth

### Node.js Module Exports (2025 patterns)
- ESM/CJS dual publishing guide: https://antfu.me/posts/publish-esm-and-cjs
- Package.json exports field: https://hirok.io/posts/package-json-exports
- tsup for building: https://github.com/egoist/tsup

## Implementation Blueprint

### Directory Structure
```
src/
├── node/                      # New Node.js transport directory
│   ├── index.ts              # Main export file
│   ├── NodeBleClient.ts      # Main client class (EventEmitter)
│   ├── NodeBleDevice.ts      # Device implementation
│   ├── NodeBleGATT.ts        # GATT server implementation  
│   ├── NodeBleService.ts     # Service implementation
│   ├── NodeBleCharacteristic.ts # Characteristic implementation
│   └── types.ts              # TypeScript type definitions
```

### Core Implementation Tasks (in order)

#### Task 1: Create Types and Interfaces
Create `src/node/types.ts`:
```typescript
// Bridge message types (copy from ws-transport.ts pattern)
export interface BridgeMessage {
  type: 'connect' | 'disconnect' | 'scan' | 'write' | 'read' | 'subscribe' | 'unsubscribe';
  id?: string;
  device?: string;
  service?: string;
  characteristic?: string;
  data?: string;
  sessionId?: string;
}

export interface BridgeResponse {
  type: 'connected' | 'disconnected' | 'scan_result' | 'notification' | 'error' | 'ack';
  id?: string;
  device?: string;
  characteristic?: string;
  data?: string;
  error?: string;
  devices?: DeviceInfo[];
}

export interface NodeBleClientOptions {
  bridgeUrl: string;
  device?: string;
  service?: string;
  write?: string;
  notify?: string;
  sessionId?: string;
  debug?: boolean;
  reconnectAttempts?: number;
  reconnectDelay?: number;
}
```

#### Task 2: Implement NodeBleClient
Create `src/node/NodeBleClient.ts`:
- Extend EventEmitter from 'events'
- Import WebSocket from 'ws' package
- Follow WebSocketTransport pattern from `src/ws-transport.ts`
- Implement Web Bluetooth API methods: getAvailability(), requestDevice(), getDevices()
- Handle WebSocket connection with retry logic (copy pattern from mock-bluetooth.ts lines 173-248)
- Map sessionId to session parameter for WebSocket URL (pattern from mock-bluetooth.ts line 189-190)

#### Task 3: Implement NodeBleDevice
Create `src/node/NodeBleDevice.ts`:
- Extend EventEmitter
- Store device properties: id, name, gatt
- Create NodeBleGATT instance in constructor
- Implement addEventListener/removeEventListener for 'gattserverdisconnected'
- Forward WebSocket messages to characteristics (pattern from mock-bluetooth.ts lines 329-349)

#### Task 4: Implement NodeBleGATT
Create `src/node/NodeBleGATT.ts`:
- Store device reference and connection state
- Implement connect() with WebSocket connection through client
- Implement disconnect() with force_cleanup (pattern from ws-transport.ts lines 131-169)
- Implement getPrimaryService() and getPrimaryServices()
- Handle connection state management

#### Task 5: Implement NodeBleService
Create `src/node/NodeBleService.ts`:
- Store service UUID and GATT server reference
- Implement getCharacteristic() and getCharacteristics()
- Return NodeBleCharacteristic instances

#### Task 6: Implement NodeBleCharacteristic
Create `src/node/NodeBleCharacteristic.ts`:
- Extend EventEmitter
- Store characteristic UUID and service reference
- Implement value property with DataView
- Implement writeValue methods (send through WebSocket)
- Implement startNotifications/stopNotifications
- Handle 'characteristicvaluechanged' events
- Convert WebSocket hex data to DataView (pattern from mock-bluetooth.ts lines 118-135)

#### Task 7: Create Main Export
Create `src/node/index.ts`:
```typescript
export { NodeBleClient } from './NodeBleClient.js';
export type { NodeBleClientOptions } from './types.js';
// Export other types as needed
```

#### Task 8: Update Package.json
Add to `package.json`:
```json
{
  "exports": {
    ".": "./dist/index.js",
    "./browser": "./dist/web-ble-mock.bundle.js",
    "./node": {
      "types": "./dist/node/index.d.ts",
      "require": "./dist/node/index.cjs",
      "import": "./dist/node/index.js"
    }
  },
  "scripts": {
    "build:node": "tsc -p tsconfig.node.json",
    "test:node": "vitest run tests/node-transport"
  }
}
```

#### Task 9: Create TypeScript Config
Create `tsconfig.node.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist/node",
    "rootDir": "src/node"
  },
  "include": ["src/node/**/*"]
}
```

#### Task 10: Implement Tests
Create test files in `tests/node-transport/`:
1. `connection.test.ts` - Test connection to bridge
2. `data-flow.test.ts` - Test write/notify operations
3. `error-handling.test.ts` - Test error scenarios
4. `protocol-validation.test.ts` - Verify message formats

Follow test patterns from:
- `tests/integration/device-interaction.test.ts` for connection patterns
- `tests/unit/mock-bluetooth.test.ts` for API testing
- Use `connectionFactory` pattern from `tests/connection-factory.ts`

#### Task 11: Version Bump
Update `package.json`:
```json
{
  "version": "0.5.11"
}
```

#### Task 12: Update CHANGELOG
Add to `CHANGELOG.md`:
```markdown
## [0.5.11] - 2025-08-25

### Added
- **Node.js Transport Client**: Complete Web Bluetooth API implementation for Node.js environments
  - New `NodeBleClient` class provides Web Bluetooth API compatibility in Node.js
  - Enables integration testing against real hardware without browser dependency
  - Full support for requestDevice, GATT operations, and notifications
  - Compatible with existing WebSocket bridge server
  - Session management and reconnection support
  - Import as: `import { NodeBleClient } from 'ble-mcp-test/node'`
  
### Changed
- Package now exports separate entry points for browser and Node.js usage
- Added dual ESM/CJS exports for Node.js transport
```

#### Task 13: Update README
Add new section to `README.md` after the browser example (around line 100):

```markdown
## Node.js Usage (v0.5.11+)

Use ble-mcp-test directly in Node.js applications for integration testing:

**Requirements:**
- Node.js 14+ for the client (uses only `ws` and built-in `events`)
- Bridge server requires Node.js 24+ (for Noble BLE access)

```javascript
import { NodeBleClient } from 'ble-mcp-test/node';

// Create client instance
const client = new NodeBleClient({
  bridgeUrl: 'ws://localhost:8080',
  device: 'CS108',        // Optional: specific device name
  service: '9800',        // Required: service UUID
  write: '9900',          // Required: write characteristic UUID
  notify: '9901',         // Required: notify characteristic UUID
  sessionId: 'test-123',  // Optional: explicit session ID
  debug: true             // Optional: enable debug logging
});

// Connect to bridge
await client.connect();

// Request device (Web Bluetooth API compatible)
const device = await client.requestDevice({
  filters: [{ namePrefix: 'CS108' }]
});

// Connect GATT
await device.gatt.connect();

// Get service and characteristics
const service = await device.gatt.getPrimaryService('9800');
const writeChar = await service.getCharacteristic('9900');
const notifyChar = await service.getCharacteristic('9901');

// Start notifications
await notifyChar.startNotifications();
notifyChar.addEventListener('characteristicvaluechanged', (event) => {
  const value = event.target.value;
  console.log('Received:', new Uint8Array(value.buffer));
});

// Write command
const command = new Uint8Array([0xA7, 0xB3, 0xC2, 0x00, 0x00, 0x11, 0x01, 0x00, 0x00, 0x00]);
await writeChar.writeValue(command);

// Cleanup
await device.gatt.disconnect();
await client.disconnect();
```

### Node.js vs Browser API Differences

| Feature | Browser Mock | Node.js Transport |
|---------|-------------|-------------------|
| Import | `import 'ble-mcp-test'` | `import { NodeBleClient } from 'ble-mcp-test/node'` |
| Initialization | `injectWebBluetoothMock()` | `new NodeBleClient()` |
| Global API | Replaces `navigator.bluetooth` | Standalone client instance |
| Events | DOM EventTarget | Node.js EventEmitter |
| Module Format | UMD bundle | ESM + CJS dual export |
| Node.js Version | N/A (runs in browser) | 14+ (client only) |
| Browser Support | Any browser (replaces Web Bluetooth) | N/A (Node.js only) |

### Integration Testing Example

```javascript
// test/integration/ble-device.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NodeBleClient } from 'ble-mcp-test/node';

describe('BLE Device Integration', () => {
  let client;
  let device;

  beforeAll(async () => {
    client = new NodeBleClient({
      bridgeUrl: 'ws://localhost:8080',
      service: '9800',
      write: '9900',
      notify: '9901'
    });
    await client.connect();
    device = await client.requestDevice();
    await device.gatt.connect();
  });

  afterAll(async () => {
    await device?.gatt.disconnect();
    await client?.disconnect();
  });

  it('should read battery voltage', async () => {
    const service = await device.gatt.getPrimaryService('9800');
    const writeChar = await service.getCharacteristic('9900');
    const notifyChar = await service.getCharacteristic('9901');

    await notifyChar.startNotifications();
    
    const response = await new Promise((resolve) => {
      notifyChar.once('characteristicvaluechanged', (event) => {
        resolve(new Uint8Array(event.target.value.buffer));
      });
      
      // Send battery voltage command
      const cmd = new Uint8Array([0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00]);
      writeChar.writeValue(cmd);
    });

    // Verify response format
    expect(response[8]).toBe(0xA0);  // Command echo
    expect(response[9]).toBe(0x00);
    
    // Extract voltage (bytes 10-11, big-endian)
    const voltage = (response[10] << 8) | response[11];
    expect(voltage).toBeGreaterThan(3000); // > 3.0V
    expect(voltage).toBeLessThan(4500);    // < 4.5V
  });
});
```
```

Also add to the Features section (around line 199):
```markdown
✅ **Node.js Transport** - Use Web Bluetooth API in Node.js applications
```

#### Task 14: Update API Documentation
Update `docs/API.md` with Node.js transport documentation:

```markdown
## Node.js Transport API

### NodeBleClient

Main client class for Node.js environments.

#### Constructor
```javascript
new NodeBleClient(options: NodeBleClientOptions)
```

**Options:**
- `bridgeUrl` (string, required): WebSocket bridge server URL
- `device` (string, optional): Device name filter
- `service` (string, required): Service UUID
- `write` (string, required): Write characteristic UUID
- `notify` (string, required): Notify characteristic UUID
- `sessionId` (string, optional): Explicit session ID
- `debug` (boolean, optional): Enable debug logging
- `reconnectAttempts` (number, optional): Max reconnection attempts (default: 3)
- `reconnectDelay` (number, optional): Delay between reconnects in ms (default: 1000)

#### Methods

##### async connect()
Connect to the WebSocket bridge server.

##### async disconnect()
Disconnect from the bridge server and cleanup resources.

##### async requestDevice(options?)
Request a BLE device (Web Bluetooth API compatible).

**Options:**
- `filters`: Array of device filters
  - `namePrefix`: Device name prefix to match
  - `services`: Service UUIDs to match

**Returns:** `NodeBleDevice` instance

##### async getAvailability()
Check if Bluetooth is available (always returns true when bridge is connected).

##### getDevices()
Get list of paired devices (returns empty array - not implemented).

### NodeBleDevice

Represents a BLE device.

#### Properties
- `id` (string): Device identifier
- `name` (string | null): Device name
- `gatt` (NodeBleGATT): GATT server instance

#### Events
- `gattserverdisconnected`: Emitted when device disconnects

### NodeBleGATT

GATT server interface.

#### Properties
- `connected` (boolean): Connection state

#### Methods
- `async connect()`: Connect to device
- `async disconnect()`: Disconnect from device
- `async getPrimaryService(uuid)`: Get primary service by UUID
- `async getPrimaryServices()`: Get all primary services

### NodeBleService

Represents a GATT service.

#### Properties
- `uuid` (string): Service UUID

#### Methods
- `async getCharacteristic(uuid)`: Get characteristic by UUID
- `async getCharacteristics()`: Get all characteristics

### NodeBleCharacteristic

Represents a GATT characteristic.

#### Properties
- `uuid` (string): Characteristic UUID
- `value` (DataView | null): Last read/notified value

#### Methods
- `async readValue()`: Read characteristic value
- `async writeValue(value)`: Write value
- `async writeValueWithResponse(value)`: Write with response
- `async writeValueWithoutResponse(value)`: Write without response
- `async startNotifications()`: Start notifications
- `async stopNotifications()`: Stop notifications

#### Events
- `characteristicvaluechanged`: Emitted when notification received
```

#### Task 15: Create Node.js Example
Create `examples/node-client-example.js`:

```javascript
#!/usr/bin/env node

/**
 * Node.js BLE Client Example
 * 
 * Demonstrates using ble-mcp-test Node.js transport to communicate
 * with a real BLE device through the WebSocket bridge.
 * 
 * Prerequisites:
 * 1. Start the bridge server: pnpm run start
 * 2. Ensure BLE device is powered on and in range
 * 3. Run this example: node examples/node-client-example.js
 */

import { NodeBleClient } from 'ble-mcp-test/node';

async function main() {
  // Create client with configuration
  const client = new NodeBleClient({
    bridgeUrl: 'ws://localhost:8080',
    device: process.env.BLE_DEVICE || 'CS108',
    service: process.env.BLE_SERVICE || '9800',
    write: process.env.BLE_WRITE || '9900', 
    notify: process.env.BLE_NOTIFY || '9901',
    debug: true
  });

  try {
    console.log('🔌 Connecting to bridge server...');
    await client.connect();
    console.log('✅ Connected to bridge');

    console.log('🔍 Requesting BLE device...');
    const device = await client.requestDevice({
      filters: [{ namePrefix: client.options.device }]
    });
    console.log(`✅ Found device: ${device.name || device.id}`);

    console.log('📡 Connecting to GATT server...');
    await device.gatt.connect();
    console.log('✅ GATT connected');

    // Get service and characteristics
    const service = await device.gatt.getPrimaryService(client.options.service);
    const writeChar = await service.getCharacteristic(client.options.write);
    const notifyChar = await service.getCharacteristic(client.options.notify);

    // Set up notifications
    console.log('🔔 Starting notifications...');
    await notifyChar.startNotifications();
    
    notifyChar.addEventListener('characteristicvaluechanged', (event) => {
      const data = new Uint8Array(event.target.value.buffer);
      const hex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`📥 Notification: ${hex}`);
      
      // Parse battery voltage if this is a battery response
      if (data.length >= 12 && data[8] === 0xA0 && data[9] === 0x00) {
        const voltage = (data[10] << 8) | data[11];
        console.log(`🔋 Battery: ${voltage}mV (${(voltage/1000).toFixed(2)}V)`);
      }
    });

    // Send battery voltage command
    console.log('📤 Sending battery voltage command...');
    const batteryCmd = new Uint8Array([
      0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00
    ]);
    await writeChar.writeValue(batteryCmd);

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Cleanup
    console.log('🧹 Disconnecting...');
    await device.gatt.disconnect();
    await client.disconnect();
    console.log('✅ Disconnected successfully');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run the example
main().catch(console.error);
```

#### Task 16: Update Examples README
Add to `examples/README.md`:

```markdown
## Node.js Client Example (node-client-example.js)

Demonstrates using the Node.js transport to communicate with BLE devices.

**Requirements:**
- Bridge server running on localhost:8080
- BLE device powered on and in range

**Usage:**
```bash
# With default settings (CS108 device)
node examples/node-client-example.js

# With custom device
BLE_DEVICE=MyDevice BLE_SERVICE=180f node examples/node-client-example.js
```

**Features demonstrated:**
- Connecting to bridge server
- Requesting BLE device
- GATT connection
- Reading/writing characteristics
- Handling notifications
- Proper cleanup
```

#### Task 17: NPM Publishing Preparation
Verify package.json has all necessary fields for publishing:

```json
{
  "engines": {
    "node": ">=14.0.0"  // Update from >=24.0.0 since client works with Node 14+
  },
  "peerDependencies": {
    "@stoprocent/noble": "^2.3.4"  // Move Noble to peer dependency
  },
  "peerDependenciesMeta": {
    "@stoprocent/noble": {
      "optional": true  // Only needed for running bridge server
    }
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE",
    "CHANGELOG.md"
  ],
  "keywords": [
    "mcp",
    "model-context-protocol", 
    "ble",
    "bluetooth",
    "bluetooth-low-energy",
    "web-bluetooth",
    "testing",
    "mock",
    "playwright",
    "e2e",
    "e2e-testing",
    "bridge",
    "websocket",
    "noble",
    "packet-inspection",
    "ble-testing",
    "web-bluetooth-mock",
    "claude",
    "ai",
    "coding-assistant",
    "nodejs",
    "node"
  ]
}
```

#### Task 18: Create Migration Guide (if needed)
Since this is a new feature and not a breaking change, create a simple adoption guide in the README:

```markdown
## Migrating from Direct WebSocket Usage

If you were previously using WebSocket directly in Node.js:

**Before (Direct WebSocket):**
```javascript
const ws = new WebSocket('ws://localhost:8080?device=CS108&service=9800');
ws.on('message', (data) => { /* handle manually */ });
```

**After (Node.js Transport):**
```javascript
import { NodeBleClient } from 'ble-mcp-test/node';
const client = new NodeBleClient({ bridgeUrl: 'ws://localhost:8080' });
const device = await client.requestDevice();
// Use Web Bluetooth API
```

Benefits of migration:
- ✅ Web Bluetooth API compatibility
- ✅ Automatic session management
- ✅ Built-in retry logic
- ✅ Type safety with TypeScript
- ✅ Event-driven architecture
```

## Critical Implementation Details

### Session Management
- MUST map `sessionId` to `session` URL parameter (mock-bluetooth.ts line 189-190)
- Auto-generate session ID if not provided (mock-bluetooth.ts lines 380-479)
- Log session mapping for debugging (mock-bluetooth.ts line 191)

### WebSocket Connection
- Include mock version marker `_mv` in URL params (ws-transport.ts lines 49-60)
- Handle connection token for force cleanup (ws-transport.ts lines 78-80)
- Implement retry logic with exponential backoff (mock-bluetooth.ts lines 176-244)

### Data Conversion
- Convert hex strings to Uint8Array for notifications
- Use DataView for Web Bluetooth API compatibility
- Handle binary data correctly in both directions

### Error Handling
- Handle "Bridge is disconnecting/connecting" errors with retry
- Implement graceful disconnect with force_cleanup
- Add post-disconnect delay for hardware recovery

## Validation Gates

### Level 1: Syntax and Type Checking
```bash
# Must pass without errors
pnpm run lint
pnpm run typecheck
```

### Level 2: Unit Tests
```bash
# Create and run Node transport tests
pnpm run test:node

# Expected: All tests pass
# - Connection tests
# - Data flow tests  
# - Error handling tests
# - Protocol validation tests
```

### Level 3: Integration Test
Create `tests/integration/node-transport-integration.test.ts`:
```typescript
import { NodeBleClient } from 'ble-mcp-test/node';

test('should connect and exchange data', async () => {
  const client = new NodeBleClient({
    bridgeUrl: 'ws://localhost:8080',
    device: 'CS108',
    service: '9800',
    write: '9900',
    notify: '9901'
  });
  
  await client.connect();
  const device = await client.requestDevice();
  await device.gatt.connect();
  
  const service = await device.gatt.getPrimaryService('9800');
  const writeChar = await service.getCharacteristic('9900');
  const notifyChar = await service.getCharacteristic('9901');
  
  await notifyChar.startNotifications();
  
  // Send command and verify response
  const command = new Uint8Array([0xA7, 0xB3, 0xC2, 0x00, 0x00, 0x11, 0x01, 0x00, 0x00, 0x00]);
  await writeChar.writeValue(command);
  
  // Cleanup
  await device.gatt.disconnect();
  await client.disconnect();
});
```

### Level 4: Build Verification
```bash
# Build the Node transport
pnpm run build:node

# Verify output
ls -la dist/node/
# Should see: index.js, index.d.ts, and other compiled files
```

### Level 5: E2E Verification
```bash
# Start bridge server
pnpm run start

# In another terminal, run Node transport tests
pnpm run test:node

# Expected: All tests pass with real BLE device
```

## Architecture Decision: Node.js Version Requirements

### Why Different Node.js Versions?
- **Bridge Server (Node.js 24+)**: Uses `@stoprocent/noble` which requires Node.js 24+ for native BLE access
- **Node.js Transport Client (Node.js 14+)**: Only uses `ws` and built-in `events`, no BLE dependencies
- **Browser Mock (Any browser)**: Replaces `navigator.bluetooth` entirely, works even without Web Bluetooth support

### Package.json Strategy
To support both use cases, we should:
1. Set `engines.node` to `>=14.0.0` (allows client usage on older Node.js)
2. Move `@stoprocent/noble` to `peerDependencies` with `optional: true`
3. Document clearly that Node.js 24+ is only needed for running the bridge server
4. The `ble-mcp-test` CLI command will check Node.js version and warn if < 24

This allows maximum flexibility:
- Users can install and use the Node.js client on Node.js 14+
- Bridge server operators need Node.js 24+
- No unnecessary restrictions for client-only usage

## Known Gotchas and Solutions

### WebSocket vs Browser WebSocket
- Node.js uses 'ws' package WebSocket, not global WebSocket
- Import explicitly: `import WebSocket from 'ws';`

### EventEmitter vs EventTarget
- Node.js uses EventEmitter, browsers use EventTarget
- Implement both patterns: on/off (EventEmitter) and addEventListener/removeEventListener

### Session ID Mapping
- WebSocketTransport expects 'session' parameter, not 'sessionId'
- Must map in connect options (critical for Playwright tests)

### Binary Data Handling
- WebSocket sends hex strings, must convert to/from Uint8Array
- Use Buffer.from() for Node.js, Uint8Array for compatibility

### Connection State Management
- Track connection state to prevent duplicate connections
- Implement proper cleanup on disconnect
- Add delays for hardware recovery

## Success Criteria

The implementation is successful when:

### Code Quality
1. ✅ All TypeScript compiles without errors
2. ✅ All lint checks pass
3. ✅ Unit tests cover all major functionality
4. ✅ Integration test successfully communicates with real device
5. ✅ Total implementation under 600 lines (excluding tests)

### Functionality
6. ✅ Can be imported as `import { NodeBleClient } from 'ble-mcp-test/node'`
7. ✅ Works with existing bridge server without modifications
8. ✅ Maintains Web Bluetooth API compatibility
9. ✅ Session reuse works across multiple client instances
10. ✅ Handles connection errors gracefully with retry

### Documentation & Versioning
11. ✅ Version bumped to 0.5.11 in package.json
12. ✅ CHANGELOG.md updated with feature description
13. ✅ README.md includes Node.js usage section with examples
14. ✅ API documentation in docs/API.md covers all Node.js classes
15. ✅ Working example in examples/node-client-example.js
16. ✅ Examples README updated with Node.js example
17. ✅ Migration guide included for users switching from direct WebSocket
18. ✅ Package.json keywords updated to include "nodejs" and "node"

### Publishing Readiness
19. ✅ Dual ESM/CJS exports configured correctly
20. ✅ TypeScript definitions generated and exported
21. ✅ All files needed for NPM included in "files" field
22. ✅ Runs successfully with `npm pack` dry run

## Final Validation Checklist

Before marking complete, verify:

```bash
# 1. Build succeeds
pnpm run build
pnpm run build:node

# 2. Tests pass
pnpm run test:node

# 3. Linting passes
pnpm run lint
pnpm run typecheck

# 4. Example runs
node examples/node-client-example.js

# 5. Documentation complete
grep -q "0.5.11" CHANGELOG.md
grep -q "Node.js Usage" README.md
grep -q "NodeBleClient" docs/API.md

# 6. Package ready for publish
npm pack --dry-run
```

## Implementation Confidence Score: 10/10

This PRP now provides:
- Complete implementation blueprint with 18 detailed tasks
- Comprehensive documentation and versioning requirements
- All necessary code patterns from existing codebase
- External documentation references for all libraries
- Executable validation steps at multiple levels
- Full API documentation templates
- Working example code
- Migration guide for existing users

The implementation path is completely defined with no ambiguity. All tasks are ordered, documented, and validated. The documentation ensures users can immediately adopt the new Node.js transport upon release.