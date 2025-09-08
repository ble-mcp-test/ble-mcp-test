# BLE Mock Bridge for Device Testing

## Primary Purpose & Critical Understanding

### What This Tool Does
**This tool enables browser-based E2E tests to control REAL BLE hardware.**

This bridge allows Playwright tests to interact with any BLE device through a mocked Web Bluetooth API. Originally developed for CS108 UHF RFID readers, it is fully **device-agnostic** and works with any BLE device that supports GATT services and characteristics.

### Device Compatibility
**This tool works with ANY BLE device**, including but not limited to:
- RFID readers (CS108, Nordic-based readers, etc.)
- IoT sensors (temperature, humidity, motion, etc.)
- Medical devices (glucose meters, blood pressure monitors, etc.)
- Fitness trackers and heart rate monitors
- Industrial equipment with BLE interfaces
- Development boards (nRF52, ESP32, Arduino with BLE, etc.)

**Requirements:** Your BLE device must support:
- GATT services and characteristics
- Read/write operations on characteristics
- Optional: Notification capabilities (for real-time data)

**Configuration:** Set your device's service and characteristic UUIDs in environment variables - no code changes needed.

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
[REAL BLE HARDWARE]
```

**Critical Understanding:**
- We mock the `navigator.bluetooth` Web API in the browser - NOT the hardware
- The bridge connects to and controls REAL BLE devices
- Commands flow: Browser → Mock → WebSocket → Bridge → Noble → Real Device
- Responses flow back through the same path in reverse
- If no real BLE hardware is available, connections will fail

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

### Hardware Availability & Troubleshooting
- `pnpm run check:device` - Scan for BLE devices to verify hardware availability
- **Troubleshooting Hardware Issues:** If E2E tests fail with "hardware not found" or "device not available" errors, run `pnpm run check:device` first to verify your BLE device is discoverable and responsive

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

## Archive Warning
**NEVER access prp/archive/ unless explicitly directed.**
The archive contains outdated specifications that will introduce incorrect patterns.

## Context & History
This is a complete rewrite. The previous implementation accumulated ~2000 lines of complexity through iterative development without clear architecture. This implementation solves one problem well: enabling browser-based tests to control real BLE hardware.
