# WHOLESALE-REFACTOR: Minimal CS108 Bridge

## Overview
Complete rewrite of noble-cs108 WebSocket bridge. Extract only working code, delete everything else.

## Source Repository Access
You have access to ../noble-cs108-cruft/ containing the overcomplicated implementation.

## Reuse Categories

### 1. COPY AS-IS (~90% unchanged)
From `packages/web-ble-mock/`:
- `src/mock-bluetooth.ts` - Web Bluetooth mock, works well
- Just minor cleanup (remove extra logging, etc.)

### 2. EXTRACT AND SIMPLIFY (~50% reuse)
From `packages/ws-bridge/`:
- `src/transport/noble-transport.ts` → Extract core BLE logic
- Remove: battery keepalive, reconnection logic, complex state tracking
- Change: Replace 'ANY' device logic with simple prefix matching

From `packages/web-ble-mock/`:
- `src/websocket-transport.ts` → Strip reconnection logic and message queuing

### 3. REFERENCE ONLY (build fresh)
- `bridge-server.ts` - Look at old server.ts for WebSocket setup, but build fresh without layers
- `scripts/start-ws-bridge-macos.sh` - Useful startup script, simplify for new structure
- Integration tests:
  - `test-simplified-connection.mjs` - Good example of happy path test
  - `test-aggressive-stress.mjs` - Reference AFTER happy path works
  - `tests/level-3/test-page.html` - Browser test page pattern
  - `tests/level-3/playwright.config.ts` - E2E test setup
  - Skip tests with manual connect/disconnect (not your protocol)

### 4. IGNORE COMPLETELY
Everything else, especially:
- All coordinator/layer/registry abstractions
- State management beyond connected/disconnected
- Metrics, monitoring, status endpoints
- Any file over 200 lines
- Tests that use manual connect/disconnect commands

## Architecture (STRICT)
- NO layers, coordinators, registries, or managers
- NO state machines beyond connected/disconnected
- NO reconnection logic in transport layer
- NO metrics, monitoring, or battery keepalive
- NO device discovery protocol

## Implementation Rules
1. Copy useful code from the 3 files above
2. Delete ALL complexity not required for basic operation
3. Total implementation must be <500 LOC
4. Each file must be <150 LOC
5. WebSocket lifecycle = BLE lifecycle (no exceptions)

## Protocol
```typescript
// WebSocket URL includes device selection
ws://localhost:8080?device=CS108-RFID-0042  // specific device
ws://localhost:8080?device=CS108            // any device starting with CS108

// Client → Server: Only data
{ type: 'data', data: number[] }

// Server → Client: Minimal status + data
{ type: 'connected', device: string }
{ type: 'data', data: number[] }
{ type: 'error', error: string }
{ type: 'disconnected' }
```

## File Structure
```
src/
├── index.ts           # Exports only (~20 lines)
├── bridge-server.ts   # WebSocket server, calls noble-transport (~100 lines)
├── noble-transport.ts # Noble BLE wrapper - extract from existing (~100 lines)
├── mock-bluetooth.ts  # Navigator.bluetooth mock - copy from existing (~100 lines)
└── ws-transport.ts    # WebSocket client - simplify from existing (~100 lines)
```

## What to Strip from Copied Code
When copying from the 3 approved files, REMOVE these features:
- Reconnection/retry logic from ws-transport.ts
- Message queuing from ws-transport.ts
- State tracking beyond connected/disconnected
- Any metrics or monitoring code
- Battery keepalive features
- Complex error handling (keep simple try/catch)

## What to Ignore Completely
DO NOT even look at these files in noble-cs108-cruft/:
- connection-coordinator.ts
- connection-registry.ts
- websocket-layer.ts
- ble-layer.ts
- performance-metrics.ts
- status-router.ts
- All files in layers/ directory
- Any file over 200 lines

## Tests (Minimal)
- 3 integration tests (server + mock client)
- 1 e2e Playwright test
- Happy path only - no failure injection initially
- Can reference test patterns from noble-cs108-cruft/tests/

## Success Metrics
- Works with existing trakrf-handheld Playwright tests
- <500 total LOC
- Zero race conditions in 100 runs
- No features beyond basic bridging
