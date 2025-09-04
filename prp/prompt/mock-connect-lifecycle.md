name: "Fix Mock Connect Lifecycle - Atomic BLE Connection Validation"
description: |

## Purpose
Fix phantom connections in ble-mcp-test bridge where WebSocket connects successfully but BLE hardware connection fails, causing tests to fail with missing characteristics. Implement atomic connection validation to ensure WebSocket only accepts connections when complete BLE stack is verified.

## Core Principles
1. **Atomic Connection**: WebSocket acceptance ONLY after complete BLE validation
2. **Clean Failures**: Failed connections must cleanup immediately with clear error codes
3. **Zombie Prevention**: No orphaned WebSocket connections without BLE backing
4. **Test Integration**: Support simulateNotification injection for E2E testing

---

## Goal
Eliminate phantom connections where WebSocket shows "connected" but notifyCharacteristic is null, causing E2E tests to fail when calling simulateNotification on missing characteristics.

## Why
- **E2E Test Reliability**: Tests currently fail silently when hardware unavailable, making CI/CD unreliable
- **User Experience**: UI shows "connected" when actually disconnected, misleading users
- **Resource Management**: Prevents orphaned WebSocket connections consuming server resources
- **Clear Error Reporting**: Enables proper test skipping when hardware unavailable

## What
Transform the current connection flow from "WebSocket first, BLE later" to "BLE validation first, WebSocket acceptance only after complete success".

### Success Criteria
- [ ] WebSocket connections are rejected immediately when BLE hardware unavailable
- [ ] No WebSocket connections exist without corresponding working BLE connections
- [ ] simulateNotification works on all "connected" sessions (real or mock)
- [ ] Clear error messages with appropriate close codes for different failure types
- [ ] Tests fail cleanly with "Hardware not available" when no CS108 device present

## All Needed Context

### Documentation & References
```yaml
# MUST READ - Include these in your context window
- url: https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent/code
  why: WebSocket close codes - use 4000-4999 for application errors, not 1002
  
- url: https://tools.ietf.org/html/rfc6455
  section: Section 7.4.1 (Close codes)
  critical: Code 1002 reserved for protocol errors, not application failures
  
- url: https://www.npmjs.com/package/@stoprocent/noble
  why: Noble async patterns - must stopScanning before connect, use connectAsync/discoverServicesAsync
  critical: Stop scanning before connecting to avoid "Command disallowed" errors
  
- file: src/bridge-server.ts:81-128
  why: Current connection logic that needs atomic validation
  
- file: src/session-manager.ts:29-79
  why: Session creation pattern to modify for connection failures
  
- file: src/ble-session.ts:41-96
  why: BLE connection logic that needs to fail-fast
  
- file: src/noble-transport.ts:180-299
  why: Noble connection pattern with proper error handling
  
- file: src/ws-transport.ts:61-102
  why: WebSocket connection logic on client side
  
- file: src/mock-bluetooth.ts:104-116
  why: simulateNotification implementation pattern
```

### Current Codebase Tree (key files)
```bash
src/
├── bridge-server.ts      # WebSocket server - needs atomic validation
├── session-manager.ts    # Session lifecycle - needs immediate cleanup on failure
├── ble-session.ts       # BLE connection - needs fail-fast validation
├── noble-transport.ts   # Noble BLE transport - connection validation logic
├── ws-handler.ts        # WebSocket message handling - needs simulateNotification
├── ws-transport.ts      # Client WebSocket - error handling
└── mock-bluetooth.ts    # Mock characteristics - simulateNotification pattern
```

### Desired Implementation Files
```bash
src/
├── bridge-server.ts      # MODIFY: Add atomic connection validation
├── session-manager.ts    # MODIFY: Add removeSession() for failures  
├── ble-session.ts       # MODIFY: Fail-fast on connection errors
├── ws-handler.ts        # MODIFY: Add simulate_notification message type
└── constants.ts          # CREATE: WebSocket close codes (4001-4005)
```

### Known Gotchas & Library Quirks
```typescript
// CRITICAL: @stoprocent/noble requires stopScanningAsync before connectAsync
// Will get "Command disallowed" or "Connection Rejected due to Limited Resources" otherwise

// CRITICAL: Noble connection errors leave BLE stack in bad state  
// Must do full cleanup with peripheral.disconnectAsync() + transport.cleanup()

// CRITICAL: WebSocket close codes 1000-2999 are reserved by spec
// Use 4000-4999 range for application-specific close codes

// CRITICAL: Session cleanup timing - zombie sessions if not removed immediately
// Sessions with hasTransport=false but no cleanup create resource leaks

// CRITICAL: simulateNotification only exists in mock, not real characteristics
// Need injection at WebSocket message handler level for real hardware testing
```

## Implementation Blueprint

### Data Models and Structure
```typescript
// WebSocket close codes for different failure types
const CLOSE_CODES = {
  HARDWARE_NOT_FOUND: 4001,
  GATT_CONNECTION_FAILED: 4002, 
  SERVICE_NOT_FOUND: 4003,
  CHARACTERISTICS_NOT_FOUND: 4004,
  BLE_DISCONNECTED: 4005
} as const;

// WebSocket message types for notification injection
interface WSMessage {
  type: 'simulate_notification' | 'notification' | /* existing types */;
  data?: number[];
}
```

### List of Tasks in Implementation Order

```yaml
Task 1 - Create Close Code Constants:
CREATE src/constants.ts:
  - EXPORT WebSocket close codes (4001-4005)
  - EXPORT close code descriptions
  - FOLLOW pattern from existing error handling

Task 2 - Add SessionManager.removeSession():
MODIFY src/session-manager.ts:
  - ADD removeSession(sessionId: string) method
  - CALL session.cleanup() before deletion
  - LOG session removal with reason
  - MAINTAIN existing session creation pattern

Task 3 - Implement Atomic BLE Validation:
MODIFY src/ble-session.ts connect() method:
  - ADD validateCompleteStack() before transport creation
  - THROW specific errors for each failure type (hardware/GATT/service/characteristics)
  - CLEANUP transport on ANY connection failure
  - PRESERVE existing transport event handlers

Task 4 - Update Bridge Server Connection Logic:
MODIFY src/bridge-server.ts WebSocket connection handler (lines 81-128):
  - MOVE BLE validation BEFORE WebSocket message sending
  - CATCH BLE connection errors and close WebSocket with appropriate codes
  - REMOVE session from SessionManager on connection failure
  - PRESERVE existing URL parameter parsing

Task 5 - Add simulateNotification Message Handler:
MODIFY src/ws-handler.ts message handling:
  - ADD 'simulate_notification' message type handler
  - INJECT notification data into session notification flow
  - SEND data to WebSocket as 'notification' type
  - MIRROR existing data message handling pattern

Task 6 - Update Client Error Handling:
MODIFY src/ws-transport.ts connect() method:
  - HANDLE 4000-4999 close codes specifically
  - PROVIDE clear error messages for each close code
  - PRESERVE existing connection retry logic
```

### Task Implementation Details

#### Task 1: Create Close Code Constants
```typescript
// src/constants.ts
export const WEBSOCKET_CLOSE_CODES = {
  HARDWARE_NOT_FOUND: 4001,
  GATT_CONNECTION_FAILED: 4002,
  SERVICE_NOT_FOUND: 4003, 
  CHARACTERISTICS_NOT_FOUND: 4004,
  BLE_DISCONNECTED: 4005
} as const;

export const CLOSE_CODE_MESSAGES = {
  [WEBSOCKET_CLOSE_CODES.HARDWARE_NOT_FOUND]: "CS108 device not found - check hardware connection",
  [WEBSOCKET_CLOSE_CODES.GATT_CONNECTION_FAILED]: "Failed to connect to device GATT server",
  [WEBSOCKET_CLOSE_CODES.SERVICE_NOT_FOUND]: "Required BLE service not available on device",
  [WEBSOCKET_CLOSE_CODES.CHARACTERISTICS_NOT_FOUND]: "Required BLE characteristics not found",
  [WEBSOCKET_CLOSE_CODES.BLE_DISCONNECTED]: "BLE device disconnected unexpectedly"
} as const;
```

#### Task 3: Atomic BLE Validation Pattern
```typescript
// PATTERN: Fail-fast validation before creating any resources
async connect(): Promise<string> {
    // STEP 1: Validate Noble state
    if (noble.state !== 'poweredOn') {
        await noble.waitForPoweredOnAsync();
    }

    // STEP 2: Find device - throw HARDWARE_NOT_FOUND if not found
    const peripheral = await this.findDevice(config);
    if (!peripheral) {
        throw new ConnectionError('HARDWARE_NOT_FOUND', 'No CS108 devices found');
    }

    // STEP 3: Connect to GATT - throw GATT_CONNECTION_FAILED if fails  
    await peripheral.connectAsync();

    // STEP 4: Discover services - throw SERVICE_NOT_FOUND if missing
    const services = await peripheral.discoverServicesAsync();
    const targetService = services.find(s => /* service matching logic */);
    if (!targetService) {
        await peripheral.disconnectAsync(); // Cleanup partial connection
        throw new ConnectionError('SERVICE_NOT_FOUND', 'BLE service not available');
    }

    // STEP 5: Discover characteristics - throw CHARACTERISTICS_NOT_FOUND if missing
    const characteristics = await targetService.discoverCharacteristicsAsync();
    const writeChar = characteristics.find(c => /* write char matching */);
    const notifyChar = characteristics.find(c => /* notify char matching */); 
    if (!writeChar || !notifyChar) {
        await peripheral.disconnectAsync(); // Cleanup partial connection
        throw new ConnectionError('CHARACTERISTICS_NOT_FOUND', 'Required characteristics missing');
    }

    // ONLY NOW - everything validated - set up transport and return success
    this.transport = new NobleTransport();
    // ... rest of successful connection setup
}
```

#### Task 4: Bridge Server Atomic Connection
```typescript
// PATTERN: Validate complete BLE stack BEFORE accepting WebSocket
this.wss.on('connection', async (ws, req) => {
    const config = /* parse config from URL */;
    
    try {
        // STEP 1: Get or create session
        const session = this.sessionManager.getOrCreateSession(sessionId, config);
        if (!session) {
            ws.close(WEBSOCKET_CLOSE_CODES.HARDWARE_NOT_FOUND, 'Device busy with another session');
            return;
        }

        // STEP 2: CRITICAL - Validate complete BLE stack before accepting WebSocket
        const deviceName = await session.connect(); // This now throws specific errors

        // STEP 3: Only NOW send success and attach WebSocket
        ws.send(JSON.stringify({ type: 'connected', device: deviceName }));
        this.sessionManager.attachWebSocket(session, ws);

    } catch (error: any) {
        // STEP 4: Connection failed - cleanup session immediately
        if (session) {
            this.sessionManager.removeSession(sessionId);
        }
        
        // STEP 5: Close WebSocket with appropriate code
        const closeCode = mapErrorToCloseCode(error);
        const message = CLOSE_CODE_MESSAGES[closeCode] || error.message;
        ws.close(closeCode, message);
    }
});
```

#### Task 5: simulateNotification Injection
```typescript
// PATTERN: Handle simulation at WebSocket message level
onMessage(data) {
    const message = JSON.parse(data);
    
    if (message.type === 'simulate_notification') {
        // Convert data array to Uint8Array
        const packet = new Uint8Array(message.data);
        
        // Send to WebSocket as if from real BLE device
        this.ws.send(JSON.stringify({
            type: 'notification',
            data: Array.from(packet)
        }));
        
        // Also trigger session handlers for consistency
        this.session.handleNotification(packet);
        return;
    }
    
    // Handle other message types...
}
```

### Integration Points
```yaml
SESSION_MANAGEMENT:
  - modify: src/session-manager.ts
  - add: removeSession() method for immediate cleanup
  - pattern: "session.cleanup(); this.sessions.delete(sessionId);"
  
ERROR_HANDLING:
  - add: src/constants.ts for close codes  
  - pattern: "export const WEBSOCKET_CLOSE_CODES = { ... }"
  - modify: All connection error handling to use 4000-4999 codes
  
WEBSOCKET_HANDLER:
  - modify: src/ws-handler.ts message handling
  - add: 'simulate_notification' message type
  - pattern: Route simulation through existing notification channels
```

## Validation Loop

### Level 1: Syntax & Style
```bash
# Run these FIRST - fix any errors before proceeding
pnpm run lint              # ESLint with auto-fix
pnpm run typecheck         # TypeScript type checking

# Expected: No errors. If errors, READ the error and fix.
```

### Level 2: Unit Tests
```typescript
// CREATE tests/unit/connection-lifecycle.test.ts
import { describe, it, expect, vi } from 'vitest';
import { BridgeServer } from '../src/bridge-server.js';

describe('Atomic Connection Validation', () => {
    it('should reject WebSocket when BLE device not found', async () => {
        // Mock Noble to return no devices
        vi.mocked(noble.startScanningAsync).mockResolvedValue();
        vi.mocked(noble.on).mockImplementation((event, callback) => {
            if (event === 'discover') {
                // Never call callback - no devices found
            }
        });
        
        const server = new BridgeServer();
        // Test WebSocket connection rejection
    });
    
    it('should cleanup session on GATT connection failure', async () => {
        // Mock peripheral.connectAsync to throw
        // Verify session is removed from SessionManager
    });
    
    it('should handle simulateNotification injection for real hardware', async () => {
        // Test that simulate_notification messages work with real BLE connections
    });
});
```

```bash
# Run and iterate until passing:
pnpm run test connection-lifecycle.test.ts
```

### Level 3: Integration Tests
```bash
# Test with no hardware (should fail cleanly)
pnpm pm2:restart
curl "ws://localhost:8080?service=6e400001-b5a3-f393-e0a9-e50e24dcca9e&write=6e400002-b5a3-f393-e0a9-e50e24dcca9e&notify=6e400003-b5a3-f393-e0a9-e50e24dcca9e"
# Expected: WebSocket close with code 4001 "Hardware not found"

# Test with hardware available (should work)  
# Hardware connection -> WebSocket acceptance -> simulateNotification works
```

### Level 4: E2E Playwright Tests  
```bash
# Run existing E2E tests - they should now fail cleanly instead of timeout
pnpm exec playwright test
# Expected: Clear "Hardware not available" failures instead of mysterious timeout/null errors
```

## Final Validation Checklist
- [ ] All tests pass: `pnpm run test`
- [ ] No linting errors: `pnpm run lint` 
- [ ] No type errors: `pnpm run typecheck`
- [ ] Bridge builds and starts: `pnpm build && pnpm pm2:restart`
- [ ] WebSocket rejects with code 4001 when no hardware: Test connection to bridge without CS108
- [ ] simulateNotification works on real hardware connections: Test with bridge + real device
- [ ] E2E tests fail cleanly when hardware unavailable: `pnpm exec playwright test` without hardware
- [ ] No zombie sessions in SessionManager after failed connections: Check session count
- [ ] Resource cleanup verified: Check Noble peripheral count after failed connections

---

## Anti-Patterns to Avoid
- ❌ Don't use WebSocket close code 1002 - it's for protocol errors only
- ❌ Don't leave sessions in SessionManager after connection failures  
- ❌ Don't accept WebSocket connections before BLE validation is complete
- ❌ Don't modify Noble characteristics directly - inject at WebSocket level
- ❌ Don't create zombie connections (WebSocket open + BLE closed)
- ❌ Don't use npm/npx - always use pnpm
- ❌ Don't skip session cleanup on errors - leads to resource leaks
- ❌ Don't assume hardware is available - always validate first

## PRP Confidence Score: 9/10
This PRP provides comprehensive context including:
✅ Specific file locations and line numbers for modifications
✅ Clear implementation patterns from existing codebase  
✅ Executable validation commands for iterative refinement
✅ WebSocket/Noble library-specific gotchas and best practices
✅ Complete task breakdown with pseudocode
✅ Integration points clearly defined
✅ Anti-patterns explicitly called out

Ready for one-pass implementation with high confidence of success.