name: "Add Bytestream Logging to Bridge Server"
description: |

## Purpose
Add byte-level traffic logging to the WebSocket-BLE bridge server to enable test verification of actual data sent to and received from BLE devices. This feature will help debug E2E tests by showing the exact byte sequences transmitted.

## Core Principles
1. **Minimal Complexity**: Simple hex formatting utility and basic log level support
2. **Zero Breaking Changes**: All existing logs remain, new logs are additive
3. **Performance Conscious**: Verbose logging can be controlled via LOG_LEVEL
4. **Test Enablement**: Format designed for easy test parsing and validation
5. **Global rules**: Follow all rules in CLAUDE.md (use pnpm, <500 LOC total)

---

## Goal
Enhance bridge server logging to display all BLE traffic as hex-formatted byte streams with clear [TX]/[RX] prefixes, while supporting standard log levels to control verbosity.

## Why
- **Test Debugging**: E2E tests need to verify exact byte sequences sent to CS108 devices
- **Protocol Analysis**: Developers need visibility into actual BLE communication
- **Troubleshooting**: Hex logs help identify data corruption or formatting issues
- **Performance**: Higher log levels prevent verbose output in production

## What
Add byte stream logging to show all BLE traffic with:
- [TX] prefix for data sent TO the BLE device
- [RX] prefix for data received FROM the BLE device  
- Uppercase hex format with space separation (e.g., `A7 B3 C2`)
- Environment variable `LOG_LEVEL` to control logging verbosity (default: debug)
- Support common log level aliases (verbose→debug, trace→debug, warn→info)
- At debug level: Show bytestream traffic and device discovery logs
- At info level: Show server startup, state changes, connections, and errors (hide bytestream and discovery)

### Success Criteria
- [ ] All BLE data transmission shows hex-formatted bytes with [TX] prefix at debug level
- [ ] All BLE data reception shows hex-formatted bytes with [RX] prefix at debug level
- [ ] Bytestream and device discovery logs hidden at info level or higher
- [ ] Server startup, connections, and errors shown at all levels
- [ ] Common log level aliases mapped correctly
- [ ] Total implementation adds <100 lines of code (including new utils.ts)

## All Needed Context

### Documentation & References
```yaml
# Node.js Buffer documentation
- url: https://nodejs.org/api/buffer.html#buftostringencoding-start-end
  why: Buffer toString('hex') method for hex conversion
  
# Current logging implementation  
- file: src/bridge-server.ts
  why: Lines 87-89 show BLE→WS data forwarding, lines 111-113 show WS→BLE
  
- file: src/noble-transport.ts
  why: Lines 466-467 scanning logs, 479 device discovery logs
  
# Test hex formatting pattern
- file: tests/integration/device-interaction.test.ts
  why: Shows existing hex format (lowercase with 0x prefix) we'll improve on

# Environment variable pattern
- file: src/start-server.ts
  why: Shows how WS_PORT and WS_HOST env vars are read

# Clarifications from spec
- file: prp/spec/add-bytestream-logging.md
  why: Lines 66-95 contain important clarifications about implementation
```

### Current Codebase tree
```bash
src/
├── bridge-server.ts      # WebSocket server, handles data forwarding
├── index.ts             # Exports only
├── mock-bluetooth.ts    # Browser mock (no changes needed)
├── noble-transport.ts   # BLE communication layer
├── start-server.ts      # Server startup, reads env vars
└── ws-transport.ts      # WebSocket client (no changes needed)
```

### Desired Codebase tree with files to be added
```bash
src/
├── bridge-server.ts      # MODIFY: Add [TX]/[RX] hex logging at debug level
├── index.ts             # MODIFY: Export utils
├── mock-bluetooth.ts    # No changes
├── noble-transport.ts   # MODIFY: Control discovery logs based on level
├── start-server.ts      # MODIFY: Read LOG_LEVEL env var, map aliases
├── utils.ts             # NEW: formatHex function and LogLevel type
└── ws-transport.ts      # No changes
```

### Known Gotchas & Library Quirks
```typescript
// CRITICAL: Noble.js uses Buffer, WebSocket uses Uint8Array
// Must convert between them correctly:
// - Noble receives: Buffer → convert to Uint8Array for WS
// - WS receives: Array<number> → convert to Uint8Array → Buffer for Noble

// CRITICAL: Follow CLAUDE.md rules
// - Use pnpm exclusively (not npm/npx)
// - Keep implementation minimal (<500 LOC total project)
// - No complex abstractions or managers

// PATTERN: Log level normalization
// Map common aliases: verbose→debug, trace→debug, warn→info
// Unknown levels default to debug with a warning
```

### Clarified Requirements
Based on spec clarifications:
1. **Logs that remain at info level**: Server startup ("Starting WebSocket server..."), Noble state changes, connections/disconnections, all errors
2. **Logs suppressed at info level**: Device discovery ("Discovered: ..."), bytestream traffic ([TX]/[RX])
3. **Scan log specificity**: Only "Discovered: devicename" logs, NOT "Scanning started/stopped"
4. **No code duplication**: Type definitions and utilities in single location
5. **Log level mapping**: Support common aliases with best-effort mapping

## Implementation Blueprint

### Data models and structure

```typescript
// src/utils.ts - NEW FILE
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function formatHex(data: Uint8Array | Buffer): string {
  const bytes = data instanceof Buffer ? data : Buffer.from(data);
  return bytes.toString('hex').toUpperCase().match(/.{2}/g)?.join(' ') || '';
}

export function normalizeLogLevel(level: string | undefined): LogLevel {
  const normalized = (level || 'debug').toLowerCase();
  
  // Map common aliases
  switch (normalized) {
    case 'debug':
    case 'verbose':
    case 'trace':
      return 'debug';
    case 'info':
      return 'info';
    case 'warn':
    case 'warning':
      return 'info'; // Per spec: warn maps to info
    case 'error':
      return 'error';
    default:
      console.warn(`[Config] Unknown log level '${level}', defaulting to debug`);
      return 'debug';
  }
}
```

### List of tasks to be completed

```yaml
Task 1:
CREATE src/utils.ts:
  - ADD: LogLevel type definition
  - ADD: formatHex function for hex formatting
  - ADD: normalizeLogLevel function with alias mapping
  - Export all three for use in other files

Task 2:
MODIFY src/index.ts:
  - ADD: Export utilities from utils.ts for external use

Task 3:
MODIFY src/start-server.ts:
  - IMPORT: normalizeLogLevel from utils.ts
  - FIND: Environment variable reading section (after WS_HOST)
  - ADD: const logLevel = normalizeLogLevel(process.env.LOG_LEVEL);
  - MODIFY: Pass logLevel to BridgeServer constructor

Task 4:
MODIFY src/bridge-server.ts:
  - IMPORT: LogLevel, formatHex from utils.ts
  - ADD: logLevel parameter to constructor
  - MODIFY: NobleTransport instantiation to pass logLevel
  - FIND: "Forwarding ${data.length} bytes to WebSocket" (line ~88)
  - ADD: if (this.logLevel === 'debug') console.log(`[RX] ${formatHex(data)}`);
  - FIND: "await this.transport.sendData" (line ~112)  
  - ADD: if (this.logLevel === 'debug') console.log(`[TX] ${formatHex(new Uint8Array(msg.data))}`);

Task 5:
MODIFY src/noble-transport.ts:
  - IMPORT: LogLevel from utils.ts
  - ADD: logLevel parameter to constructor and store as property
  - FIND: console.log(`[NobleTransport] Discovered: ${name || 'Unknown'} (${device.id})`); (line ~479)
  - WRAP: if (this.logLevel === 'debug') around discovery log
  - NOTE: Keep "Scanning started", "Noble state", connection logs at all levels
  
Task 6:
TEST manually:
  - Run without LOG_LEVEL: Verify [TX]/[RX] and discovery logs appear
  - Run with LOG_LEVEL=info: Verify no [TX]/[RX] or discovery logs
  - Run with LOG_LEVEL=verbose: Verify it maps to debug
  - Run with LOG_LEVEL=warn: Verify it maps to info
  - Run with LOG_LEVEL=invalid: Verify warning and default to debug
```

### Per task pseudocode

```typescript
// Task 1 - utils.ts (NEW FILE)
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function formatHex(data: Uint8Array | Buffer): string {
  const bytes = data instanceof Buffer ? data : Buffer.from(data);
  return bytes.toString('hex').toUpperCase().match(/.{2}/g)?.join(' ') || '';
}

export function normalizeLogLevel(level: string | undefined): LogLevel {
  const normalized = (level || 'debug').toLowerCase();
  
  switch (normalized) {
    case 'debug':
    case 'verbose':
    case 'trace':
      return 'debug';
    case 'info':
      return 'info';
    case 'warn':
    case 'warning':
      return 'info';
    case 'error':
      return 'error';
    default:
      console.warn(`[Config] Unknown log level '${level}', defaulting to debug`);
      return 'debug';
  }
}

// Task 2 - index.ts
export { BridgeServer } from './bridge-server.js';
export { NobleTransport } from './noble-transport.js';
export { WebSocketTransport } from './ws-transport.js';
export { formatHex, normalizeLogLevel, type LogLevel } from './utils.js';  // ADD THIS

// Task 3 - start-server.ts
import { BridgeServer } from './bridge-server.js';
import { normalizeLogLevel } from './utils.js';  // ADD THIS

const port = parseInt(process.env.WS_PORT || '8080', 10);
const host = process.env.WS_HOST || '0.0.0.0';
const logLevel = normalizeLogLevel(process.env.LOG_LEVEL);  // ADD THIS

console.log('🚀 Starting WebSocket-to-BLE Bridge Server');
console.log(`   Port: ${port}`);
console.log(`   Host: ${host}`);
console.log(`   Log level: ${logLevel}`);  // ADD THIS
console.log('   Device-agnostic - UUIDs provided by client');
console.log('   Press Ctrl+C to stop\n');

const server = new BridgeServer(logLevel);  // PASS LOG LEVEL

// Task 4 - bridge-server.ts
import { WebSocketServer } from 'ws';
import { NobleTransport, ConnectionState } from './noble-transport.js';
import { LogLevel, formatHex } from './utils.js';  // ADD THIS

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private transport: NobleTransport | null = null;
  private zombieCheckInterval: any = null;
  private logClients: Set<any> = new Set();
  private logLevel: LogLevel;  // ADD THIS
  
  constructor(logLevel: LogLevel = 'debug') {  // ADD PARAMETER
    this.logLevel = logLevel;
  }
  
  // In transport creation
  if (!this.transport) {
    this.transport = new NobleTransport(this.logLevel);  // PASS LOG LEVEL
  }
  
  // In data handler
  onData: (data) => {
    console.log(`[BridgeServer] Forwarding ${data.length} bytes to WebSocket`);
    if (this.logLevel === 'debug') {
      console.log(`[RX] ${formatHex(data)}`);  // ADD THIS
    }
    ws.send(JSON.stringify({ type: 'data', data: Array.from(data) }));
  }
  
  // In message handler
  if (msg.type === 'data' && msg.data && this.transport) {
    const dataArray = new Uint8Array(msg.data);
    if (this.logLevel === 'debug') {
      console.log(`[TX] ${formatHex(dataArray)}`);  // ADD THIS
    }
    await this.transport.sendData(dataArray);
  }
}

// Task 5 - noble-transport.ts
import noble from '@stoprocent/noble';
import { LogLevel } from './utils.js';  // ADD THIS

export class NobleTransport {
  private logLevel: LogLevel;  // ADD THIS
  
  constructor(logLevel: LogLevel = 'debug') {  // ADD PARAMETER
    this.logLevel = logLevel;
  }
  
  // In discovery handler (around line 479)
  if (this.logLevel === 'debug') {  // WRAP discovery log
    console.log(`[NobleTransport] Discovered: ${name || 'Unknown'} (${device.id})`);
  }
  
  // Keep these logs at all levels:
  // - console.log('[NobleTransport] Scanning started');
  // - console.log('[NobleTransport] Bluetooth powered on');
  // - console.log(`[NobleTransport] Connecting to ${this.deviceName}...`);
  // - All error messages
}
```

### Integration Points
```yaml
ENVIRONMENT:
  - add to: README.md (document LOG_LEVEL options)
  - document: "LOG_LEVEL=debug|info|warn|error (also supports verbose, trace)"
  
STARTUP SCRIPT:
  - file: scripts/start-ws-bridge-macos.sh (if exists)
  - add: LOG_LEVEL="${LOG_LEVEL:-debug}"  # After other env vars
  
CONFIG PASSING:
  - start-server.ts → BridgeServer constructor
  - BridgeServer → NobleTransport constructor
  
TYPE SAFETY:
  - All log level strings normalized through normalizeLogLevel()
  - Type safety enforced via LogLevel type
```

## Validation Loop

### Level 1: Syntax & Style
```bash
# Run these FIRST - fix any errors before proceeding
pnpm run lint              # ESLint with auto-fix
pnpm run typecheck         # TypeScript type checking

# Expected: No errors. If errors, READ the error and fix.
```

### Level 2: Manual Testing
```bash
# Test default debug mode
pnpm run build
pnpm run start

# In another terminal, check for byte logs:
# Should see: [TX] A7 B3 C2 01 00 00 00 00 B3 A7
# Should see: [RX] B3 A7 C2 01 00 00 00 00 A7 B3
# Should see: [NobleTransport] Discovered: CS108 (uuid)

# Test with info-level logging
LOG_LEVEL=info pnpm run start

# Should NOT see [TX]/[RX] logs
# Should NOT see "Discovered:" logs  
# Should STILL see:
# - "Starting WebSocket server..."
# - "Noble state changed..."
# - Connection/disconnection logs
# - Error messages

# Test log level mapping
LOG_LEVEL=verbose pnpm run start  # Should behave like debug
LOG_LEVEL=trace pnpm run start    # Should behave like debug
LOG_LEVEL=warn pnpm run start     # Should behave like info
LOG_LEVEL=invalid pnpm run start  # Should warn and default to debug
```

### Level 3: Integration Test
```bash
# Run existing tests - ensure nothing breaks
pnpm run test

# Run E2E test with debug logging
LOG_LEVEL=debug pnpm exec playwright test

# Verify hex logs in output
# Check that tests still pass with different log levels
LOG_LEVEL=info pnpm exec playwright test
```

## Final validation Checklist
- [ ] All tests pass: `pnpm run test`
- [ ] No linting errors: `pnpm run lint`
- [ ] No type errors: `pnpm run typecheck`
- [ ] Build succeeds: `pnpm run build`
- [ ] Default mode (LOG_LEVEL unset or debug) shows [TX]/[RX] hex logs
- [ ] LOG_LEVEL=info hides byte traffic and discovery logs
- [ ] LOG_LEVEL=info still shows startup, connections, errors
- [ ] Common aliases (verbose, trace, warn) map correctly
- [ ] Invalid log levels show warning and default to debug
- [ ] Hex format matches spec: uppercase, space-separated
- [ ] No code duplication (types and utils in one place)
- [ ] Total changes < 100 lines of code

---

## Anti-Patterns to Avoid
- ❌ Don't implement complex log level hierarchy - just simple checks
- ❌ Don't duplicate type definitions or utility functions
- ❌ Don't change existing log formats - only add new ones
- ❌ Don't suppress important logs (errors, connections) at any level
- ❌ Don't use npm/npx - always use pnpm
- ❌ Don't over-engineer - this is a simple feature
- ❌ Don't add dependencies - use built-in Buffer.toString('hex')

## Implementation Confidence Score: 9.5/10

This updated PRP has very high confidence because:
- All clarifications from spec have been incorporated
- Clear separation of concerns with utils.ts
- No code duplication (single source of truth)
- Supports common log level aliases developers expect
- Maintains backward compatibility
- Clear distinction between debug-only and always-visible logs
- Simple implementation with minimal complexity
- Comprehensive testing plan covers all scenarios

The slight uncertainty (0.5 points) is only around the exact line numbers in the existing code, but the search patterns provided will locate the correct positions.