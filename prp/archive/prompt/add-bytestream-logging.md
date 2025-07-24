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
Enhance bridge server logging to display all BLE traffic as hex-formatted byte streams with clear [TX]/[RX] prefixes, while supporting standard log levels to control verbosity. Document changes in a new CHANGELOG.md file.

## Why
- **Test Debugging**: E2E tests need to verify exact byte sequences sent to CS108 devices
- **Protocol Analysis**: Developers need visibility into actual BLE communication
- **Troubleshooting**: Hex logs help identify data corruption or formatting issues
- **Performance**: Higher log levels prevent verbose output in production
- **Version Tracking**: CHANGELOG.md provides clear release history for users

## What
Add byte stream logging to show all BLE traffic with:
- [TX] prefix for data sent TO the BLE device
- [RX] prefix for data received FROM the BLE device  
- Uppercase hex format with space separation (e.g., `A7 B3 C2`)
- Environment variable `LOG_LEVEL` to control logging verbosity (default: debug)
- Support common log level aliases (verbose→debug, trace→debug, warn→info)
- At debug level: Show bytestream traffic and device discovery logs
- At info level: Show server startup, state changes, connections, and errors (hide bytestream and discovery)
- Bump package version to 0.2.0
- Update README.md with LOG_LEVEL documentation
- Create CHANGELOG.md with release history

### Success Criteria
- [ ] All BLE data transmission shows hex-formatted bytes with [TX] prefix at debug level
- [ ] All BLE data reception shows hex-formatted bytes with [RX] prefix at debug level
- [ ] Bytestream and device discovery logs hidden at info level or higher
- [ ] Server startup, connections, and errors shown at all levels
- [ ] Common log level aliases mapped correctly
- [ ] Package version bumped to 0.2.0
- [ ] README.md updated with LOG_LEVEL documentation
- [ ] CHANGELOG.md created with proper format and content
- [ ] Total implementation adds <120 lines of code (including utils.ts and CHANGELOG.md)

## All Needed Context

### Documentation & References
```yaml
# Node.js Buffer documentation
- url: https://nodejs.org/api/buffer.html#buftostringencoding-start-end
  why: Buffer toString('hex') method for hex conversion - produces lowercase, no spaces
  
# Changelog best practices
- url: https://keepachangelog.com/en/1.1.0/
  why: Standard format for CHANGELOG.md - humans first, specific sections, reverse chronological
  
# Current logging implementation  
- file: src/bridge-server.ts
  why: Line 88 shows BLE→WS data forwarding, line 112 shows WS→BLE
  
- file: src/noble-transport.ts
  why: Line 467 scanning logs, 479 device discovery logs
  
# Test hex formatting pattern
- file: tests/integration/device-interaction.test.ts
  why: Shows existing hex format (lowercase with 0x prefix) we'll improve on

# Environment variable pattern
- file: src/start-server.ts
  why: Lines 5-6 show how WS_PORT and WS_HOST env vars are read

# Package version location
- file: package.json
  why: Line 3 contains version "0.1.1" to update to "0.2.0"

# README environment variables section
- file: README.md
  why: Lines 166-168 show where to add LOG_LEVEL documentation

# Clarifications from spec
- file: prp/spec/add-bytestream-logging.md
  why: Lines 72-100 contain important clarifications about implementation
```

### Current Codebase tree
```bash
src/
├── bridge-server.ts      # WebSocket server, handles data forwarding
├── index.ts             # Exports only (5 lines)
├── mock-bluetooth.ts    # Browser mock (no changes needed)
├── noble-transport.ts   # BLE communication layer
├── start-server.ts      # Server startup, reads env vars
└── ws-transport.ts      # WebSocket client (no changes needed)

./                       # Root directory
├── package.json         # Version needs update
├── README.md           # Needs LOG_LEVEL docs
└── (no CHANGELOG.md)   # Needs to be created
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

./                       # Root directory
├── CHANGELOG.md        # NEW: Release history following Keep a Changelog
├── package.json        # MODIFY: Version bump to 0.2.0
└── README.md          # MODIFY: Add LOG_LEVEL documentation
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

// GOTCHA: Buffer.toString('hex') produces lowercase without spaces
// Must use .toUpperCase() and regex to add spaces between byte pairs

// PATTERN: Changelog format
// - Reverse chronological order (newest first)
// - Use standard sections: Added, Changed, Fixed, etc.
// - Date format: YYYY-MM-DD
```

### Clarified Requirements
Based on spec clarifications:
1. **Logs that remain at info level**: Server startup ("Starting WebSocket server..."), Noble state changes, connections/disconnections, all errors
2. **Logs suppressed at info level**: Device discovery ("Discovered: ..."), bytestream traffic ([TX]/[RX])
3. **Scan log specificity**: Only "Discovered: devicename" logs, NOT "Scanning started/stopped"
4. **No code duplication**: Type definitions and utilities in single location
5. **Log level mapping**: Support common aliases with best-effort mapping
6. **Changelog format**: Follow Keep a Changelog standard with proper sections

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
  - AFTER: export { normalizeUuid } from './noble-transport.js';

Task 3:
MODIFY src/start-server.ts:
  - IMPORT: normalizeLogLevel from utils.ts
  - FIND: const host = process.env.WS_HOST || '0.0.0.0'; (line 6)
  - ADD AFTER: const logLevel = normalizeLogLevel(process.env.LOG_LEVEL);
  - FIND: console.log(`   Host: ${host}`); (line 10)
  - ADD AFTER: console.log(`   Log level: ${logLevel}`);
  - MODIFY: const server = new BridgeServer(); to new BridgeServer(logLevel);

Task 4:
MODIFY src/bridge-server.ts:
  - IMPORT: LogLevel, formatHex from utils.ts (after line 2)
  - ADD: private logLevel: LogLevel; in class properties (after line 8)
  - ADD: constructor(logLevel: LogLevel = 'debug') { this.logLevel = logLevel; }
  - MODIFY: this.transport = new NobleTransport(); to new NobleTransport(this.logLevel); (line 65)
  - FIND: console.log(`[BridgeServer] Forwarding ${data.length} bytes to WebSocket`); (line 88)
  - ADD AFTER: if (this.logLevel === 'debug') console.log(`[RX] ${formatHex(data)}`);
  - FIND: await this.transport.sendData(new Uint8Array(msg.data)); (line 112)  
  - ADD BEFORE: if (this.logLevel === 'debug') console.log(`[TX] ${formatHex(new Uint8Array(msg.data))}`);

Task 5:
MODIFY src/noble-transport.ts:
  - IMPORT: LogLevel from utils.ts (after line 1)
  - ADD: private logLevel: LogLevel; in class properties (after line 83)
  - ADD: constructor(logLevel: LogLevel = 'debug') { this.logLevel = logLevel; }
  - FIND: console.log(`[NobleTransport] Discovered: ${name || 'Unknown'} (${device.id})`); (line 479)
  - WRAP: if (this.logLevel === 'debug') { ... } around discovery log
  - NOTE: Keep "Scanning started", "Noble state", connection logs at all levels

Task 6:
MODIFY package.json:
  - FIND: "version": "0.1.1", (line 3)
  - CHANGE TO: "version": "0.2.0",

Task 7:
MODIFY README.md:
  - FIND: Environment variables: section (line 166)
  - ADD AFTER WS_PORT line: - `LOG_LEVEL` - Logging verbosity: debug|info|warn|error (default: `debug`)
  - ADD NOTE: Supports aliases: verbose/trace→debug, warn/warning→info

Task 8:
CREATE CHANGELOG.md:
  - Follow Keep a Changelog format
  - Add entry for v0.2.0 with all new features
  - Add entry for v0.1.1 and v0.1.0 as initial releases
  - Use standard sections: Added, Changed, Fixed, etc.
  
Task 9:
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

// Task 8 - CHANGELOG.md (NEW FILE)
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2025-07-23

### Added
- Byte-level traffic logging with [TX]/[RX] prefixes showing all BLE communication
- Hex-formatted output for better readability (uppercase with space separation)
- `LOG_LEVEL` environment variable to control logging verbosity (debug|info|warn|error)
- Support for common log level aliases (verbose/trace→debug, warn/warning→info)
- Utility functions for hex formatting and log level normalization
- This CHANGELOG file to track version history

### Changed
- Default logging now shows byte-level BLE traffic (can be suppressed with LOG_LEVEL=info)
- Bridge server and Noble transport now accept log level configuration

## [0.1.1] - 2025-07-XX

### Fixed
- Minor bug fixes and improvements

## [0.1.0] - 2025-07-XX

### Added
- Initial release
- WebSocket-to-BLE bridge server
- Web Bluetooth API mock for testing
- Support for CS108 RFID readers and other BLE devices
- Cross-platform compatibility (macOS, Linux, Raspberry Pi)
- Basic connection management and data forwarding
```

### Integration Points
```yaml
ENVIRONMENT:
  - add to: README.md (document LOG_LEVEL options)
  - document: "LOG_LEVEL=debug|info|warn|error (also supports verbose, trace)"
  
STARTUP SCRIPT:
  - file: scripts/start-ws-bridge-macos.sh
  - check if exists and add: LOG_LEVEL="${LOG_LEVEL:-debug}"
  
CONFIG PASSING:
  - start-server.ts → BridgeServer constructor
  - BridgeServer → NobleTransport constructor
  
TYPE SAFETY:
  - All log level strings normalized through normalizeLogLevel()
  - Type safety enforced via LogLevel type

CHANGELOG:
  - Follow Keep a Changelog format
  - Reverse chronological order
  - Standard sections: Added, Changed, Deprecated, Removed, Fixed, Security
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

# Verify CHANGELOG.md format
cat CHANGELOG.md  # Should show proper Keep a Changelog format
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
- [ ] Package version updated to 0.2.0
- [ ] README.md updated with LOG_LEVEL documentation
- [ ] CHANGELOG.md created with proper format and sections
- [ ] Total changes < 120 lines of code

---

## Anti-Patterns to Avoid
- ❌ Don't implement complex log level hierarchy - just simple checks
- ❌ Don't duplicate type definitions or utility functions
- ❌ Don't change existing log formats - only add new ones
- ❌ Don't suppress important logs (errors, connections) at any level
- ❌ Don't use npm/npx - always use pnpm
- ❌ Don't over-engineer - this is a simple feature
- ❌ Don't add dependencies - use built-in Buffer.toString('hex')
- ❌ Don't deviate from Keep a Changelog format

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
- Exact line numbers provided from code inspection
- Package version bump included
- README update included
- CHANGELOG.md follows industry standard format
- All new requirements from updated spec are addressed

The slight uncertainty (0.5 points) is only around potential edge cases in the byte array conversion, but the provided patterns handle the common cases well.