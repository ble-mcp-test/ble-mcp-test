# BLE Mock Bridge for CS108 Testing

## Primary Purpose & Critical Understanding

### What This Tool Does
**This tool enables browser-based E2E tests to control REAL BLE hardware.**

The CS108 is a UHF RFID reader (https://www.convergence.com.hk/cs108/) in a sled form factor controlled via BLE. This bridge allows Playwright tests to interact with the actual device through a mocked Web Bluetooth API.

### Architecture: Browser → Mock API → Bridge → Real Hardware

```
[Browser/Playwright Test]
         ↓
[mock-bluetooth.ts - Mocks navigator.bluetooth API ONLY]
         ↓
    (WebSocket)
         ↓
[Bridge Server (bridge-server.ts)]
         ↓
[Noble Transport (noble-transport.ts)]
         ↓
[REAL CS108 HARDWARE]
```

**Critical Understanding:**
- We mock the `navigator.bluetooth` Web API in the browser - NOT the hardware
- The bridge connects to and controls REAL BLE devices
- Commands flow: Browser → Mock → WebSocket → Bridge → Noble → Real Device
- Responses flow back through the same path in reverse
- If no real CS108 is available, connections will fail

### Success Metrics
1. **Playwright E2E Compatibility** - Each test creates a fresh browser context; our session management must handle this
2. **Full Path Communication** - Must verify end-to-end: connect + send test request/response through complete chain
3. **Simplicity** - Target ~500 LOC (guidance, not hard limit)

## Critical Technical Constraints

### Noble.js Async Operations (Frequent Source of Errors)
The old codebase mixed callbacks with promises, causing race conditions.

**Requirements:**
- Use ONLY @stoprocent/noble (v0.1.14)
- Use ONLY async/await patterns
- ALWAYS await Noble operations
- Callbacks acceptable ONLY in event handlers

```javascript
// INCORRECT (old pattern that causes issues)
peripheral.connect(() => {
  peripheral.discoverServices(); // Returns promise but not awaited!
});

// CORRECT
await peripheral.connectAsync();
await peripheral.discoverServicesAsync();
```

### Common Implementation Errors
These issues have repeatedly caused problems:

1. **Device Name Confusion** - Noble often reports devices as "Unknown" on Linux. This does NOT mean the device isn't the expected type.
2. **Hardware vs Mock Confusion** - The mock provides Web Bluetooth API only. Real devices provide actual responses.
3. **Session Persistence** - localStorage that only works within a browser session is insufficient for Playwright tests.

### Playwright Test Environment
Production deployment runs on headless VMs without display capabilities.

**Requirements:**
- ALWAYS run Playwright tests in headless mode
- NEVER use `headless: false` in test configurations
- Tests must work without GUI access

```javascript
// INCORRECT (will fail on headless VM)
const browser = await chromium.launch({ headless: false });

// CORRECT
const browser = await chromium.launch({ headless: true }); // or omit (default)
```

## Development Guidelines

### Package Manager (Strict Requirement)
- Use pnpm EXCLUSIVELY
- NEVER use npm, npx, or yarn
- Replace `npx` with `pnpm exec` or `pnpm dlx`

```bash
# INCORRECT
npx playwright test
npm run build

# CORRECT
pnpm exec playwright test
pnpm run build
```

### Git Workflow
Never commit directly to main. Use feature branches:
- `feature/` - New features
- `fix/` - Bug fixes
- `refactor/` - Code refactoring
- `docs/` - Documentation
- `test/` - Test updates

### Clean Code Principles
1. DELETE don't deprecate - no .old files or commented code
2. Target ~100 lines per file (guidance for clarity)
3. No abstraction layers, managers, or coordinators
4. Node.js 24.x required for BLE compatibility

### What NOT to Build
- ❌ State machines (beyond connected/disconnected)
- ❌ Reconnection logic in transport
- ❌ Metrics, monitoring, battery keepalive
- ❌ Device discovery protocol
- ❌ Manual connect/disconnect commands

## Operations & Commands

### Build & Deploy
After any bridge code changes:
```bash
pnpm build && pnpm pm2:restart
```

### PM2 Process Management
- `pnpm pm2:status` - Check server status
- `timeout 1 pnpm pm2:logs` - View recent logs (timeout prevents auto-tailing)
- `pnpm pm2:restart` - Restart the server
- `pnpm pm2:stop` - Stop the server
- `pnpm pm2:start` - Start the server
- `pnpm pm2:monitor` - Interactive monitoring

### Hardware Availability Check
- `pnpm run check:device` - Scan for CS108 devices to verify hardware availability

## Project Structure

### Expected Files
```
src/
├── index.ts           # Exports only
├── bridge-server.ts   # WebSocket server
├── noble-transport.ts # Noble BLE wrapper
├── mock-bluetooth.ts  # navigator.bluetooth mock
└── ws-transport.ts    # WebSocket client

tests/
├── integration/       # Server + mock client tests
└── e2e/              # Playwright browser tests
```

### Reference Sources (from ../noble-cs108-cruft/)
- `mock-bluetooth.ts` - Keep 90% as-is
- `websocket-transport.ts` - Remove reconnection logic
- `noble-transport.ts` - Extract core BLE only

## Archive Warning
**NEVER access prp/archive/ unless explicitly directed.**
The archive contains outdated specifications that will introduce incorrect patterns.

## Context & History
This is a complete rewrite. The previous implementation accumulated ~2000 lines of complexity through iterative development without clear architecture. This implementation solves one problem well: enabling browser-based tests to control real BLE hardware.
