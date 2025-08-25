# Node.js Transport Implementation PRP

## Goal
Add a Node.js transport client to ble-mcp-test that provides Web Bluetooth API compatibility for Node.js environments, enabling integration testing against real hardware through the bridge server. This will allow Node.js applications to test BLE devices using the same API as browser-based tests.

## Context
This project (ble-mcp-test) is a WebSocket-to-BLE bridge that allows testing real BLE devices in Playwright/E2E tests without browser support. The current implementation provides:
- A WebSocket bridge server (`src/bridge-server.ts`) 
- A browser mock implementation (`src/mock-bluetooth.ts`)
- WebSocket transport (`src/ws-transport.ts`)
- Noble BLE transport (`src/noble-transport.ts`)

The Node.js transport will provide the same Web Bluetooth API interface for Node.js environments, routing through the existing WebSocket bridge.

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
1. ✅ All TypeScript compiles without errors
2. ✅ All lint checks pass
3. ✅ Unit tests cover all major functionality
4. ✅ Integration test successfully communicates with real device
5. ✅ Can be imported as `import { NodeBleClient } from 'ble-mcp-test/node'`
6. ✅ Works with existing bridge server without modifications
7. ✅ Maintains Web Bluetooth API compatibility
8. ✅ Session reuse works across multiple client instances
9. ✅ Handles connection errors gracefully with retry
10. ✅ Total implementation under 600 lines (excluding tests)

## Implementation Confidence Score: 9/10

This PRP provides comprehensive context from the existing codebase, clear implementation patterns to follow, external documentation references, and executable validation steps. The only uncertainty is around potential edge cases with real BLE devices, which will be caught during integration testing.

The implementation should be straightforward by following the existing mock-bluetooth.ts patterns and adapting them for Node.js environment with proper EventEmitter usage and ws WebSocket library.