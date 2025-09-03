# Instructions for Claude Code

## Bridge Server Management with PM2
The BLE bridge server runs under PM2 process manager. Use these commands:
- `pnpm pm2:status` - Check server status
- `timeout 1 pnpm pm2:logs` - View recent logs (timeout prevents auto-tailing)
- `pnpm pm2:restart` - Restart the server (needed after code changes)
- `pnpm pm2:stop` - Stop the server
- `pnpm pm2:start` - Start the server
- `pnpm pm2:monitor` - Interactive monitoring

**IMPORTANT: After making changes to the bridge code, you MUST run:**
```bash
pnpm build && pnpm pm2:restart
```

## 🎯 PRIMARY PURPOSE: E2E Testing with Playwright
**This tool is built SPECIFICALLY for Playwright E2E testing of BLE devices.**
- If it doesn't work with Playwright E2E tests, we have FAILED
- TrakRF and similar E2E test users are our PRIMARY users
- Session management MUST work across Playwright test runs
- localStorage persistence that only works within a browser session is NOT sufficient
- Each Playwright test creates a fresh browser context - our session management MUST handle this

## ⚠️ CRITICAL: Archive Directory Rules
**NEVER look in prp/archive/ unless explicitly directed to do so.**
- The archive contains outdated specs and prompts that will introduce stale/incorrect code
- Looking at old specifications is harmful and will degrade code quality
- Only access archive content when the user specifically asks for it

## Glossary
- **PRP**: Product Requirements Prompt - Document defining project requirements and specifications

## ⚠️ MANDATORY: Package Manager Rules
1. This project uses pnpm EXCLUSIVELY
2. NEVER use npm or npx - use pnpm instead
3. Replace ALL instances of `npx` with `pnpm exec` or `pnpm dlx`
4. Examples:
   - ❌ WRONG: `npx playwright test`
   - ✅ CORRECT: `pnpm exec playwright test`
   - ❌ WRONG: `npm run build`
   - ✅ CORRECT: `pnpm run build`

## Git Workflow Rules

**NEVER commit or push directly to main branch. ALWAYS use feature branches.**

### Branch Naming Convention:
- `feature/` - New features (e.g., `feature/add-device-filtering`)
- `fix/` - Bug fixes (e.g., `fix/websocket-timeout`)
- `refactor/` - Code refactoring (e.g., `refactor/simplify-transport`)
- `docs/` - Documentation updates (e.g., `docs/update-readme`)
- `test/` - Test additions or fixes (e.g., `test/add-integration-tests`)

### Workflow:
1. Create descriptive branch: `git checkout -b feature/description`
2. Make changes and commit with clear messages
3. Push to branch: `git push origin feature/description`
4. Create PR for review (mention this to user)
5. Never merge directly - always via PR

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
3. Total implementation < 600 LOC
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
