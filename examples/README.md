# ble-mcp-test Examples

This directory contains examples and test utilities for the ble-mcp-test library.

## Node.js Client Example (node-client-example.js)

Demonstrates using the Node.js transport to communicate with BLE devices.

**Requirements:**
- Bridge server running on localhost:8080
- BLE device powered on and in range
- Node.js 14+ (client only needs ws and EventEmitter)

**Usage:**
```bash
# With default settings (CS108 device)
node examples/node-client-example.js

# With custom device
BLE_DEVICE=MyDevice BLE_SERVICE=180f node examples/node-client-example.js
```

**Features demonstrated:**
- Connecting to bridge server
- Requesting BLE device
- GATT connection
- Reading/writing characteristics
- Handling notifications
- Proper cleanup

## Cache Busting Test (version-check.html)

Tests the cache-busting functionality of the web bundle:
- Load bundle with version suffix (recommended)
- Load bundle with timestamp query parameter
- Check loaded version against expected version

**Usage:**
```bash
# Start a local server
python3 -m http.server 8000
# Open http://localhost:8000/examples/version-check.html
```

## Session Persistence Test (minimal-session-repro.html)

Minimal reproduction for testing session ID persistence across page reloads.

**Requirements:**
- WebSocket bridge server must be running on localhost:8080

**Usage:**
```bash
# Start the bridge server
pnpm run start

# In another terminal, start a local server
python3 -m http.server 8000
# Open http://localhost:8000/examples/minimal-session-repro.html
```

**Steps to test:**
1. Click "Inject Mock" to initialize the Web Bluetooth mock
2. Click "Show Session Info" to see current session details
3. Click "Connect Device" to attempt connection (requires bridge server)
4. Click "Reload Page" to test session persistence
5. Repeat steps 1-3 to verify session is reused

## Session Persistence Demo (session-persistence-demo.js)

Node.js script demonstrating session persistence functionality.

**Usage:**
```bash
node examples/session-persistence-demo.js
```

## Force Cleanup Examples

Examples demonstrating the force cleanup functionality for stuck sessions:
- `force-cleanup-simple.html` - Interactive HTML test
- `force-cleanup-example.js` - Node.js example
- `force-cleanup-playwright.ts` - Playwright test example

All force cleanup examples require the bridge server to be running.