name: "Fix NodeBleClient API - Simplify and Eliminate Web Bluetooth Emulation"
description: |

## Purpose
Simplify and fix NodeBleClient API to match browser mock consistency and eliminate unnecessary Web Bluetooth API emulation. Replace unreliable device name-based discovery with service-UUID based discovery and make sessionId required for consistency.

## Core Principles
1. **Context is King**: Include ALL necessary documentation, examples, and caveats
2. **Validation Loops**: Provide executable tests/lints the AI can run and fix
3. **Information Dense**: Use keywords and patterns from the codebase
4. **Progressive Success**: Start simple, validate, then enhance
5. **Global rules**: Be sure to follow all rules in CLAUDE.md

---

## Goal
Transform NodeBleClient from a Web Bluetooth API emulation to a simple Node.js BLE client that leverages the bridge server's full BLE connection capabilities with service-UUID based discovery and required sessionId for session management consistency.

## Why
- **Eliminate Unreliable Device Name Discovery**: Noble often reports devices as "Unknown" on Linux, making name-based discovery fragile
- **API Consistency**: Browser mock requires sessionId - NodeBleClient should too
- **Simplify User Experience**: Single connect() call instead of multi-step requestDevice() → gatt.connect() ceremony
- **Leverage Bridge Server**: Bridge already does full BLE connection during WebSocket handshake - don't duplicate the work
- **Integration Testing**: Enable robust integration tests that validate NodeBleClient → Bridge → Hardware communication path

## What
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

### Success Criteria
- [ ] NodeBleClient uses service-UUID based discovery (not device name)
- [ ] sessionId is required (consistent with browser mock)
- [ ] Single `connect()` call establishes full BLE connection (no requestDevice() needed)
- [ ] Integration test validates NodeBleClient → Bridge → Hardware communication path
- [ ] API is simpler and more Node.js appropriate than Web Bluetooth emulation
- [ ] Tests pass before npm publish (prevents broken releases)

## All Needed Context

### Documentation & References (list all context needed to implement the feature)
```yaml
# MUST READ - Include these in your context window
- file: src/node/NodeBleClient.ts
  why: Current implementation to be modified - shows Web Bluetooth emulation pattern to remove
  
- file: examples/node-client-example.js  
  why: Shows current broken multi-step pattern that needs simplification
  
- file: src/bridge-server.ts
  lines: 68-89
  why: WebSocket URL parameter handling and BLE config validation - shows bridge does full connection
  
- file: src/session-manager.ts
  lines: 61-104
  why: Session creation and management - shows sessionId is critical for session management
  
- file: src/mock-bluetooth.ts
  lines: 763-764
  why: Browser mock sessionId validation pattern - shows required sessionId error handling
  
- file: src/noble-transport.ts
  lines: 115-166
  why: Noble discovery logic with service-UUID filtering and optional device matching
  
- file: tests/e2e/test-config.ts
  why: TEST_COMMAND_BYTES and TEST_RESPONSE_VALIDATION constants, testCommandHelper function
  
- file: examples/playwright-test-helpers.ts
  why: Shared test helpers pattern for integration testing
  
- file: src/node/types.ts
  why: Current type definitions that need updating
```

### Current Codebase tree (focused on NodeBleClient area)
```bash
src/
├── node/
│   ├── NodeBleClient.ts      # MAIN FILE TO MODIFY
│   ├── NodeBleDevice.ts      # May need updates
│   ├── NodeBleGATT.ts        # May need updates  
│   ├── NodeBleService.ts     # May need updates
│   ├── NodeBleCharacteristic.ts # May need updates
│   ├── types.ts              # UPDATE: NodeBleClientOptions interface
│   └── index.ts              # Export new API
├── bridge-server.ts          # REFERENCE: WebSocket parameter handling
├── session-manager.ts        # REFERENCE: Session management
├── mock-bluetooth.ts         # REFERENCE: sessionId validation
└── noble-transport.ts        # REFERENCE: Discovery logic

examples/
├── node-client-example.js    # UPDATE: Show new simplified API
└── playwright-test-helpers.ts # REFERENCE: Integration test patterns

tests/
├── e2e/test-config.ts        # REFERENCE: testCommandHelper, TEST_COMMAND_BYTES
├── integration/              # CREATE: NodeBleClient integration tests
└── unit/                     # CREATE: NodeBleClient unit tests
```

### Desired Codebase tree with files to be added and responsibility of file
```bash
src/node/
├── NodeBleClient.ts          # SIMPLIFIED: Direct WebSocket+BLE connection, service discovery
├── types.ts                  # UPDATED: New NodeBleClientOptions with required sessionId
└── index.ts                  # EXPORT: Updated API

tests/integration/
└── node-client.test.ts       # NEW: Integration test using testCommandHelper

examples/
└── node-client-example.js    # UPDATED: Show new simplified API pattern
```

### Known Gotchas of our codebase & Library Quirks
```typescript
// CRITICAL: pnpm ONLY - NEVER use npm/npx/yarn (CLAUDE.md requirement)
// CRITICAL: Device names often show as "Unknown" on Linux - don't rely on names
// CRITICAL: Service-UUID filtering works reliably across platforms (noble-transport.ts)
// CRITICAL: Bridge server handles all async operations - client should be mostly synchronous after connect
// CRITICAL: Session management requires sessionId for proper cleanup (session-manager.ts)
// CRITICAL: Multiple peripheral objects for same device cause subscription accumulation (noble quirk)
// CRITICAL: Browser mock validates sessionId is required - NodeBleClient should match (mock-bluetooth.ts:763-764)
// CRITICAL: Use @stoprocent/noble v0.1.14 ONLY with async/await patterns
// CRITICAL: Follow "DELETE don't deprecate" principle - remove old patterns completely
```

## Implementation Blueprint

### Data models and structure

Update the type definitions to reflect the new simplified API:
```typescript
// src/node/types.ts - UPDATED interface
export interface NodeBleClientOptions {
  sessionId: string;              // REQUIRED - consistent with browser mock
  bridgeUrl: string;             // WebSocket bridge URL
  service: string;               // Service UUID for discovery (PRIMARY METHOD)
  write: string;                 // Write characteristic UUID
  notify: string;                // Notify characteristic UUID
  deviceId?: string;             // Optional: Exact device ID for filtering
  deviceName?: string;           // Optional: Partial device name for filtering
  debug?: boolean;
  timeout?: number;              // Optional: Connection timeout
}

// Remove unnecessary Web Bluetooth emulation types
// DELETE: RequestDeviceOptions (no longer needed)
// DELETE: DeviceInfo (use bridge server's response format)
```

### list of tasks to be completed to fulfill the PRP in the order they should be completed

```yaml
Task 1: Update NodeBleClientOptions interface
MODIFY src/node/types.ts:
  - MAKE sessionId required (not optional)
  - REMOVE device parameter (replaced by optional deviceId/deviceName)
  - ADD optional deviceId and deviceName parameters
  - REMOVE RequestDeviceOptions interface (no longer needed)
  - KEEP bridgeUrl, service, write, notify, debug
  - ADD optional timeout parameter

Task 2: Simplify NodeBleClient core implementation  
MODIFY src/node/NodeBleClient.ts:
  - FIND constructor validation pattern
  - ADD sessionId required validation (throw error if missing)
  - MODIFY connectInternal() to pass deviceId/deviceName instead of device
  - REMOVE requestDevice() method entirely
  - ADD direct writeValue(data: Uint8Array): Promise<void> method
  - ADD direct onNotification(handler: (data: Uint8Array) => void): void method
  - PRESERVE existing WebSocket connection and message handling patterns
  - PRESERVE existing cleanup and session management

Task 3: Update bridge server URL parameter mapping
MODIFY src/node/NodeBleClient.ts connectInternal():
  - CHANGE url.searchParams.set('device', this.options.device) 
  - TO optional url.searchParams.set('deviceId', this.options.deviceId)
  - TO optional url.searchParams.set('deviceName', this.options.deviceName)
  - PRESERVE existing session, service, write, notify parameter mapping

Task 4: Create integration test with shared helpers
CREATE tests/integration/node-client.test.ts:
  - IMPORT testCommandHelper from '../e2e/test-config'
  - IMPORT TEST_COMMAND_BYTES and TEST_RESPONSE_VALIDATION from '../e2e/test-config'
  - TEST service-only discovery (no device filtering)
  - TEST optional device filtering (deviceId and deviceName)
  - TEST error handling (missing sessionId, bridge not running)
  - TEST session reuse doesn't cause characteristic staleness
  - USE existing Vitest patterns from tests/unit/

Task 5: Update example to show new simplified API
MODIFY examples/node-client-example.js:
  - REMOVE multi-step requestDevice() → gatt.connect() pattern
  - SHOW new single connect() call pattern  
  - ADD required sessionId parameter
  - CHANGE device parameter to optional deviceId/deviceName
  - PRESERVE existing test command and notification handling
  - ADD error handling examples

Task 6: Update documentation
MODIFY docs/API.md:
  - UPDATE NodeBleClient section with new API
  - DOCUMENT breaking changes clearly
  - ADD migration guide from old to new API
  
UPDATE CHANGELOG.md:
  - ADD breaking changes section
  - DOCUMENT API simplification benefits
  
BUMP package.json version to 0.7.3 (patch for breaking changes)
```

### Per task pseudocode as needed added to each task

```typescript
// Task 2: Simplified NodeBleClient implementation
export class NodeBleClient extends EventEmitter {
  constructor(options: NodeBleClientOptions) {
    super();
    
    // VALIDATION: Throw early for missing required parameters
    if (!options.sessionId) {
      throw new Error('sessionId is required - this prevents session conflicts and ensures predictable BLE connection management');
    }
    if (!options.service || !options.write || !options.notify) {
      throw new Error('service, write, and notify parameters are required');
    }
    
    this.options = { ...options };
  }
  
  // SIMPLIFIED: Single connect call does WebSocket + BLE connection
  async connect(): Promise<void> {
    // PRESERVE: Existing retry logic and WebSocket connection
    // MODIFY: URL parameters to use deviceId/deviceName instead of device
    const url = new URL(this.options.bridgeUrl);
    if (this.options.deviceId) url.searchParams.set('deviceId', this.options.deviceId);
    if (this.options.deviceName) url.searchParams.set('deviceName', this.options.deviceName);
    // ... rest of existing connection logic
  }
  
  // NEW: Direct write method (no GATT ceremony)
  async writeValue(data: Uint8Array): Promise<void> {
    // PATTERN: Use existing sendMessage infrastructure
    const response = await this.sendMessage({
      type: 'write',
      data: Array.from(data)
    });
    // Handle response...
  }
  
  // NEW: Direct notification setup (no characteristic object needed)
  onNotification(handler: (data: Uint8Array) => void): void {
    // PATTERN: Use existing message handler infrastructure
    // Forward notifications from setupMessageHandler to user callback
  }
  
  // REMOVE: requestDevice() method entirely
  // REMOVE: getDevices() method (not needed for simple API)
}

// Task 4: Integration test pattern
import { describe, it, expect } from 'vitest';
import { testCommandHelper, TEST_COMMAND_BYTES, TEST_RESPONSE_VALIDATION } from '../e2e/test-config';
import { NodeBleClient } from '../../src/node/NodeBleClient';

describe('NodeBleClient integration', () => {
  it('should connect and execute test command', async () => {
    const client = new NodeBleClient({
      sessionId: 'test-session-' + Date.now(),
      bridgeUrl: 'ws://localhost:8080',
      service: '9800',
      write: '9900',
      notify: '9901'
    });
    
    await client.connect();
    
    // PATTERN: Adapt testCommandHelper for NodeBleClient
    const result = await testCommandHelper({
      writeValue: (data) => client.writeValue(data),
      onNotification: (handler) => client.onNotification(handler),
      command: TEST_COMMAND_BYTES,
      validate: TEST_RESPONSE_VALIDATION
    });
    
    expect(result).toBe(true);
    await client.disconnect();
  });
});
```

### Integration Points
```yaml
BRIDGE_SERVER:
  - pattern: WebSocket URL parameters (deviceId, deviceName instead of device)
  - file: src/bridge-server.ts lines 77-78
  
SESSION_MANAGER:
  - pattern: sessionId requirement and validation
  - file: src/session-manager.ts lines 61-104
  
NOBLE_TRANSPORT:
  - pattern: Service-UUID based discovery with optional device filtering
  - file: src/noble-transport.ts lines 140-147
  
TEST_INFRASTRUCTURE:
  - pattern: testCommandHelper function reuse
  - file: tests/e2e/test-config.ts
  - constants: TEST_COMMAND_BYTES, TEST_RESPONSE_VALIDATION
```

## Validation Loop

### Level 1: Syntax & Style
```bash
# Run these FIRST - fix any errors before proceeding
pnpm run lint              # ESLint with auto-fix
pnpm run typecheck         # TypeScript type checking

# Expected: No errors. If errors, READ the error and fix.
```

### Level 2: Unit Tests each new feature/file/function use existing test patterns
```typescript
// CREATE tests/unit/node-client.test.ts - Unit tests for NodeBleClient class
import { describe, it, expect, vi } from 'vitest';
import { NodeBleClient } from '../../src/node/NodeBleClient';

describe('NodeBleClient', () => {
  it('should require sessionId in constructor', () => {
    expect(() => new NodeBleClient({
      bridgeUrl: 'ws://localhost:8080',
      service: '9800',
      write: '9900', 
      notify: '9901'
      // Missing sessionId
    })).toThrow('sessionId is required');
  });

  it('should require service/write/notify parameters', () => {
    expect(() => new NodeBleClient({
      sessionId: 'test',
      bridgeUrl: 'ws://localhost:8080'
      // Missing service, write, notify
    })).toThrow('service, write, and notify parameters are required');
  });

  it('should accept optional deviceId and deviceName', () => {
    expect(() => new NodeBleClient({
      sessionId: 'test',
      bridgeUrl: 'ws://localhost:8080',
      service: '9800',
      write: '9900',
      notify: '9901',
      deviceId: 'AA:BB:CC:DD:EE:FF',
      deviceName: 'CS108'
    })).not.toThrow();
  });
});
```

```bash
# Run unit tests and iterate until passing:
pnpm run test tests/unit/node-client.test.ts
# If failing: Read error, understand root cause, fix code, re-run (never mock to pass)
```

### Level 3: Integration Test
```bash
# Ensure bridge server is running
pnpm run start &
sleep 2

# Run integration test with real bridge server  
pnpm run test tests/integration/node-client.test.ts

# Expected: Test connects to bridge and executes test command successfully
# If error: Check bridge server logs and test output for specific failure
```

### Level 4: Example Verification
```bash
# Test the updated example
node examples/node-client-example.js

# Expected: Single connect() call followed by successful command execution
# If error: Check example follows new API pattern correctly
```

## Final validation Checklist
- [ ] All tests pass: `pnpm run test`
- [ ] No linting errors: `pnpm run lint`
- [ ] No type errors: `pnpm run typecheck`
- [ ] Build succeeds: `pnpm run build`
- [ ] Example runs successfully: `node examples/node-client-example.js`
- [ ] Integration test validates full communication path
- [ ] Error cases handled gracefully (missing sessionId, bridge not running)
- [ ] Session reuse works correctly without characteristic staleness
- [ ] Documentation updated with breaking changes and migration guide

---

## Anti-Patterns to Avoid
- ❌ Don't keep Web Bluetooth API emulation - remove requestDevice(), gatt objects entirely
- ❌ Don't rely on device names for discovery - use service-UUID as primary method
- ❌ Don't make sessionId optional - browser mock requires it, NodeBleClient should too
- ❌ Don't create new connection patterns - reuse existing WebSocket infrastructure  
- ❌ Don't skip integration tests - must validate NodeBleClient → Bridge → Hardware path
- ❌ Don't use npm/npx - always use pnpm (CLAUDE.md requirement)
- ❌ Don't deprecate old methods - DELETE them completely (CLAUDE.md principle)
- ❌ Don't ignore Noble.js quirks - service-UUID filtering is reliable, name filtering is not

---

## External Research Context

### Noble.js Behavior References
- Device names often show as "Unknown" on Linux - don't rely on names for discovery
- Service-UUID filtering works reliably across platforms
- Multiple peripheral objects for same device cause subscription accumulation

### WebSocket Bridge Architecture  
- Bridge server does full BLE connection during WebSocket handshake
- Bridge handles all Noble.js async operations internally
- Client just needs to send commands over WebSocket after connection

### Session Management Requirements
- Browser mock requires sessionId and validates it strictly
- Session manager uses sessionId for connection pooling and cleanup
- Multiple clients with same sessionId reuse connections

### Integration Testing Patterns
- testCommandHelper function eliminates manual GATT operations in tests
- TEST_COMMAND_BYTES and TEST_RESPONSE_VALIDATION provide consistent test data
- Shared helpers between E2E and integration tests ensure consistency