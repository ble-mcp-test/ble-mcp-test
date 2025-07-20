# Instructions for Claude Code

## Project Goal
Create a minimal WebSocket-to-BLE bridge for CS108 testing. Target: <500 lines total.

## Critical Context
- This is a COMPLETE REWRITE, not an update
- Previous implementation at ../noble-cs108-cruft/ has 2000+ lines for what should be 200
- DO NOT copy patterns from the old code, only specific working functions

## Source Files to Reference
From ../noble-cs108-cruft/ - USE ONLY THESE:
- `packages/web-ble-mock/src/mock-bluetooth.ts` - Keep 90% as-is
- `packages/web-ble-mock/src/websocket-transport.ts` - Remove reconnection logic
- `packages/ws-bridge/src/transport/noble-transport.ts` - Extract core BLE only

## Noble.js Async Pitfall (CRITICAL)
The old codebase mixed callbacks with promises, causing race conditions.

**MANDATORY:**
- Use ONLY @stoprocent/noble (v0.1.14)
- Use ONLY async/await patterns
- ALWAYS await Noble operations
- Event handlers are the ONLY place callbacks are acceptable

**Example:**
```javascript
// WRONG (old pattern)
peripheral.connect(() => {
  peripheral.discoverServices(); // Returns promise but not awaited!
});

// CORRECT
await peripheral.connectAsync();
await peripheral.discoverServicesAsync();
```

## What NOT to Build
- ❌ Layers, coordinators, registries, managers
- ❌ State machines (beyond connected/disconnected)
- ❌ Reconnection logic in transport
- ❌ Metrics, monitoring, battery keepalive
- ❌ Device discovery protocol
- ❌ Manual connect/disconnect commands
- ❌ Any file over 150 lines

## Clean Code Rules
1. DELETE don't deprecate - no .old files, no commented code
2. If a file isn't listed above, don't copy it
3. Total implementation < 500 LOC
4. Use pnpm exclusively (not npm/yarn)
5. Node.js 24.x required for BLE compatibility

## Expected Structure
```
src/
├── index.ts           # ~20 lines - exports only
├── bridge-server.ts   # ~100 lines - WebSocket server
├── noble-transport.ts # ~100 lines - Noble BLE wrapper
├── mock-bluetooth.ts  # ~100 lines - navigator.bluetooth mock
└── ws-transport.ts    # ~100 lines - WebSocket client

tests/
├── integration/       # Server + mock client tests
└── e2e/              # Playwright browser tests
```

## Testing Approach
1. Happy path integration tests first
2. Add stress tests only after basics work
3. No unit tests for simple forwarding functions
4. Test files can reference from noble-cs108-cruft/tests/

## Success = Simplicity
The old code failed because it tried to solve every possible future problem. 
This time: solve exactly one problem well.
