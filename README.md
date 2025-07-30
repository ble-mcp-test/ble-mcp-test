# ble-mcp-test

```
[BLE]──●──[MCP]──●──[AI agent]
```

Bridge Bluetooth devices to your AI coding assistant via Model Context Protocol.

## What is this?

This package solves a common problem: **testing Web Bluetooth code in environments that don't support it**. It provides:

1. **A WebSocket bridge server** that runs on a machine with BLE hardware (like a Raspberry Pi or Mac)
2. **A Web Bluetooth API mock** that you use in your browser tests to communicate with real BLE devices through the bridge

This lets you write and test Web Bluetooth applications on any machine, even if it doesn't have Bluetooth hardware or browser support.

> **⚠️ Breaking Changes in v0.4.0**
> 
> Version 0.4.0 introduces a complete architectural rewrite with no backward compatibility:
> - New atomic state machine (ready → connecting → active → disconnecting)
> - Simplified WebSocket protocol - one connection per device
> - Separation of bridge and observability services
> - Removal of all complex orchestration layers
> 
> If you're upgrading from v0.3.x, please see [MIGRATION.md](./docs/MIGRATION.md) for details.

## Installation

### For testing (recommended)
```bash
# npm
npm install --save-dev ble-mcp-test

# pnpm
pnpm add -D ble-mcp-test

# yarn
yarn add --dev ble-mcp-test
```

### For production use
```bash
# npm
npm install ble-mcp-test

# pnpm  
pnpm add ble-mcp-test

# yarn
yarn add ble-mcp-test
```

## Quick Start

### Step 1: Run the Bridge Server (on a machine with BLE)

```bash
# Using pnpm dlx (no installation needed)
pnpm dlx ble-mcp-test

# Or if installed globally
ble-mcp-test
```

The server will start on `ws://localhost:8080` by default.

## Breaking Changes in v0.4.0

### Connection Token (BREAKING)
All WebSocket connections now receive a unique token upon successful BLE connection:
```json
// Old format (v0.3.x)
{ "type": "connected", "device": "CS108-123456" }

// New format (v0.4.0)
{ "type": "connected", "device": "CS108-123456", "token": "550e8400-e29b-41d4-a716-446655440000" }
```

### Client Idle Timeout (NEW)
Clients are now automatically disconnected after 45 seconds of inactivity:
- Send a `{ "type": "keepalive" }` message to reset the idle timer
- Receive an `eviction_warning` before disconnection (5-second grace period)
- Configure timeout with `BLE_MCP_CLIENT_IDLE_TIMEOUT` environment variable

### Enhanced Health Endpoint (ENHANCED)
The health check now includes state machine information:
```json
{
  "type": "health",
  "status": "ok",
  "free": true,
  "state": "IDLE",  // NEW: IDLE, ACTIVE, or EVICTING
  "transportState": "disconnected",
  "connectionInfo": null,  // NEW: Includes token, deviceName, timestamps
  "timestamp": "2025-01-30T12:34:56.789Z"
}
```

### Single Connection Enforcement (BEHAVIOR CHANGE)
- Only one active BLE connection allowed at a time
- Enforced by atomic mutex to prevent race conditions
- Connection attempts while busy receive: `"Another connection is active"`

### Device Health Check

Check if your BLE device is available before running tests:

```bash
# Quick device check
pnpm check:device

# Health check with success message
pnpm check:health
```

This will scan for your configured device and provide clear feedback if it's not found.

### Configuration

The bridge server can be configured using environment variables:

```bash
# Set WebSocket port (default: 8080)
BLE_MCP_WS_PORT=3000 pnpm dlx ble-mcp-test

# Set host interface (default: 0.0.0.0)
BLE_MCP_WS_HOST=127.0.0.1 pnpm dlx ble-mcp-test

# Set log level (default: debug)
# Options: debug, info, warn, error
# Also supports: verbose, trace (maps to debug), warning (maps to info)
BLE_MCP_LOG_LEVEL=info pnpm dlx ble-mcp-test

# Set client idle timeout (default: 45000ms / 45 seconds)
# Clients are disconnected after this period of inactivity
BLE_MCP_CLIENT_IDLE_TIMEOUT=60000 pnpm dlx ble-mcp-test

# Advanced BLE timing configuration (milliseconds)
# Override platform-specific defaults for your hardware
# Note: Default values vary by platform (macOS/Windows/Linux)
BLE_MCP_RECOVERY_DELAY=1000         # BLE stack recovery time (Noble reset + disconnect cooldown)
BLE_MCP_SCAN_TIMEOUT=15000          # Maximum time to scan for devices
BLE_MCP_CONNECTION_TIMEOUT=15000    # Maximum time to establish connection
```

**Log Levels:**
- `debug` - Shows all logs including [TX]/[RX] bytestream traffic and device discovery
- `info` - Shows server startup, connections, state changes, and errors (hides bytestream and discovery logs)
- `warn`/`error` - Shows warnings and errors only

### Monitoring Server Logs

For debugging and log analysis, use the MCP tools:

```bash
# View logs from the server log file
pnpm logs

# Use MCP tools for advanced log analysis
# Available tools: get_logs, search_packets, get_connection_state, status
# Access via Claude Code or HTTP API at http://localhost:8081/mcp
```

Note: Real-time log streaming via WebSocket was removed in v0.4.0 to maintain the ultra-simple architecture. Use MCP tools for debugging and log analysis.

### Step 2: Use in Your Browser Tests

```html
<!-- In your test HTML -->
<script src="node_modules/ble-mcp-test/dist/web-ble-mock.bundle.js"></script>
<script>
    // Initialize the mock with your bridge server URL
    WebBleMock.injectWebBluetoothMock('ws://localhost:8080');

    // Now use Web Bluetooth API as normal!
    async function connectToDevice() {
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'MyDevice' }],
            optionalServices: ['180f'] // Battery service
        });

        const server = await device.gatt.connect();
        const service = await server.getPrimaryService('180f');
        const characteristic = await service.getCharacteristic('2a19');
        const value = await characteristic.readValue();
        console.log('Battery level:', value.getUint8(0), '%');
    }
</script>
```

## Complete Examples

### Example 1: Playwright E2E Test

```javascript
import { test, expect } from '@playwright/test';

test('read battery level from BLE device', async ({ page }) => {
  // Load test page
  await page.goto('/test.html');

  // Inject the Web Bluetooth mock
  await page.addScriptTag({
    path: 'node_modules/ble-mcp-test/dist/web-ble-mock.bundle.js'
  });

  // Initialize mock with bridge server
  await page.evaluate(() => {
    WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
  });

  // Test Web Bluetooth code
  const batteryLevel = await page.evaluate(async () => {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'MyDevice' }]
    });
    const server = await device.gatt.connect();
    // ... rest of Web Bluetooth code
    return batteryLevel;
  });

  expect(batteryLevel).toBeGreaterThan(0);
});
```

### Example 2: Device-Agnostic Configuration

The bridge supports any BLE device. Specify your device's UUIDs via URL parameters:

```javascript
// Configure for a custom BLE device
const bridgeUrl = new URL('ws://localhost:8080');
bridgeUrl.searchParams.set('device', 'MyDevice');      // Device name prefix
bridgeUrl.searchParams.set('service', '180f');         // Service UUID
bridgeUrl.searchParams.set('write', '2a19');          // Write characteristic UUID
bridgeUrl.searchParams.set('notify', '2a20');         // Notify characteristic UUID

WebBleMock.injectWebBluetoothMock(bridgeUrl.toString());
```

The bridge accepts UUIDs in multiple formats:
- **Short form**: `180F`, `2A19` (16-bit UUIDs)
- **Full form with dashes**: `0000180F-0000-1000-8000-00805F9B34FB`
- **Full form without dashes**: `0000180f00001000800000805f9b34fb`
- **Case insensitive**: `BEEF`, `BEef`, `beef` all work the same

### Example 3: Running Bridge on Remote Machine

```bash
# On Raspberry Pi with BLE hardware
BLE_MCP_WS_HOST=0.0.0.0 BLE_MCP_WS_PORT=8080 pnpm dlx ble-mcp-test

# In your tests (from another machine)
WebBleMock.injectWebBluetoothMock('ws://raspberrypi.local:8080');
```

## Configuration

### Bridge Server Options

Environment variables:
- `BLE_MCP_WS_HOST` - WebSocket host (default: `0.0.0.0`)
- `BLE_MCP_WS_PORT` - WebSocket port (default: `8080`)
- `BLE_MCP_LOG_LEVEL` - Logging level: debug, info, warn, error (default: `debug`)
- `BLE_MCP_HTTP_PORT` - MCP HTTP server port (default: `8081`, setting this enables HTTP transport)
- `BLE_MCP_HTTP_TOKEN` - Bearer token for MCP authentication (setting this enables HTTP transport)
- `BLE_MCP_LOG_BUFFER_SIZE` - Circular buffer size for logs (default: `10000`, min: 100, max: 1000000)

### Device Configuration

Pass device configuration via URL parameters:
- `device` - Device name prefix to search for
- `service` - BLE service UUID
- `write` - Write characteristic UUID
- `notify` - Notify characteristic UUID

Example:
```
ws://localhost:8080?device=CS108&service=9800&write=9900&notify=9901
```

## Testing

**Important**: Tests must be run sequentially, not in parallel. The bridge enforces single connection behavior because there's only one physical BLE device. Running tests in parallel will result in connection conflicts, which is the expected and correct behavior.

```bash
# Run integration tests sequentially (correct)
pnpm test:run tests/integration/connection.test.ts
pnpm test:run tests/integration/device-interaction.test.ts

# Running all tests in parallel (will fail)
pnpm test:run tests/integration/  # ❌ Tests will conflict
```

### Why Sequential Testing?

The WebSocket-to-BLE bridge maintains a singleton connection to the physical device. This is by design:
- Only one WebSocket client can control a BLE device at a time
- Attempting parallel connections will fail with "Another connection is active"
- This prevents tests from interfering with each other's device state
- Each test gets exclusive access to the device
- Future multi-device support would allow parallel testing with different devices

## How It Works

1. **Bridge Server**: Runs on a machine with BLE hardware, creates WebSocket server
2. **Web Bluetooth Mock**: Replaces `navigator.bluetooth` in the browser
3. **Communication**: Mock sends Web Bluetooth API calls over WebSocket to bridge
4. **BLE Operations**: Bridge performs actual BLE operations using Noble.js
5. **Results**: Bridge sends results back to browser over WebSocket

**Important**: The bridge currently supports **one connection at a time**. Multiple WebSocket clients can connect, but only one can have an active BLE connection. This design prevents race conditions and ensures reliable operation.

## Architecture Diagram

The following sequence diagram shows the complete data flow from test to device.

> **Note**: If you're viewing this on npm and don't see the diagram below, please [view it on GitHub](https://github.com/trakrf/web-ble-bridge#architecture-diagram) for the interactive Mermaid diagram.

```mermaid
sequenceDiagram
    participant Test as Playwright Test
    participant Browser as Browser (Mock)
    participant Bridge as Bridge Server
    participant BLE as BLE Device

    Note over Test,Browser: 1. Test Setup
    Test->>Browser: injectWebBluetoothMock('ws://localhost:8080')
    Browser->>Browser: Replace navigator.bluetooth

    Note over Test,BLE: 2. Device Connection
    Test->>Browser: navigator.bluetooth.requestDevice()
    Browser->>Bridge: WebSocket connect<br/>ws://localhost:8080?device=CS108&service=...
    Bridge->>BLE: Noble scan for device
    BLE-->>Bridge: Device found
    Bridge->>BLE: Connect via Noble
    BLE-->>Bridge: Connected
    Bridge-->>Browser: {"type": "connected", "device": "CS108-123"}
    Browser-->>Test: Return MockBluetoothDevice

    Note over Test,BLE: 3. Data Exchange
    Test->>Browser: characteristic.writeValue([0xA7, 0xB3, ...])
    Browser->>Bridge: {"type": "data", "data": [167, 179, ...]}
    Bridge->>BLE: Write via Noble
    
    BLE->>Bridge: Notification data
    Bridge->>Browser: {"type": "data", "data": [179, 167, ...]}
    Browser->>Test: characteristicvaluechanged event

    Note over Test,BLE: 4. Disconnection
    Test->>Browser: device.gatt.disconnect()
    Browser->>Bridge: WebSocket close
    Bridge->>BLE: Disconnect via Noble
    Bridge->>Bridge: Cleanup connection
```

## Protocol

The bridge uses a simple JSON protocol over WebSocket:

### Browser → Bridge
```json
{ "type": "data", "data": [0xA7, 0xB3, 0x02, ...] }
```

### Bridge → Browser
```json
{ "type": "connected", "device": "MyDevice-123456" }
{ "type": "data", "data": [0xB3, 0xA7, 0x04, ...] }
{ "type": "error", "error": "No device found" }
{ "type": "disconnected" }
```

## Requirements

- **Bridge Server**: Node.js 24.x (required for Noble.js BLE support)
- **Browser**: Any modern browser (Chrome, Firefox, Safari, Edge)
- **BLE Hardware**: Only needed on the machine running the bridge server

## Troubleshooting

### "No device found" error
- Ensure BLE is enabled on the bridge server machine
- Check that your device is powered on and in range
- Verify the device name prefix matches

### "Connection timeout" error
- Check firewall settings if using remote bridge
- Ensure WebSocket port is accessible
- Try using IP address instead of hostname

### Bridge server crashes
- Ensure Node.js 24.x is installed (not 22.x or 26.x)
- Check for other processes using the same port
- Run with debug logging: `BLE_MCP_LOG_LEVEL=debug pnpm dlx ble-mcp-test`

## Documentation

- [API Documentation](docs/API.md) - Detailed API reference
- [Migration Guide](docs/MIGRATION.md) - Migrating from native Web Bluetooth

## Using with Claude Code

### Direct Integration via MCP Server

The ble-mcp-test server always includes MCP (Model Context Protocol) tools for powerful debugging and analysis. By default, MCP uses stdio transport for security (no network ports opened). To enable HTTP transport on port 8081:

```json
// In your Claude Code settings.json
{
  "mcpServers": {
    "ble-mcp-test": {
      "transport": "http",
      "url": "http://localhost:8081/mcp",
      "headers": {
        "Authorization": "Bearer your-optional-token"
      }
    }
  }
}
```

#### Available MCP Tools

1. **get_logs** - Retrieve recent BLE communication logs
2. **search_packets** - Search for hex patterns in packet history
3. **get_connection_state** - Monitor current connection status
4. **status** - Get bridge server status and statistics
5. **scan_devices** - Scan for nearby BLE devices

#### MCP Transport Options

```bash
# Default: WebSocket bridge + stdio MCP (for local development)
pnpm start

# Add HTTP transport for testing MCP endpoints (no auth)
pnpm start:http

# CI/CD mode: HTTP with fixed test token
pnpm start:ci

# Run in background (useful for automated tests)
pnpm start:bg
pnpm logs     # view logs from file
pnpm stop     # stop server
```

#### CI/CD Testing

For integration tests and CI pipelines:

```bash
# Fixed token for predictable testing
pnpm start:ci
# Server runs with BLE_MCP_HTTP_TOKEN=test-token on HTTP port 8081

# Or set custom token for specific test scenarios
BLE_MCP_HTTP_TOKEN=custom-token pnpm start:http
```

This enables natural language BLE interactions in Claude Code:
- "What BLE devices are available?"
- "Show me recent BLE communication logs"
- "Search for packets containing A7B3"
- "What's the current connection status?"

### Server Options

The bridge server supports the following options:

```bash
# Start with default settings (stdio MCP, no network ports)
ble-mcp-test

# Enable HTTP transport for MCP on port 8081
ble-mcp-test --mcp-http

# All other configuration via environment variables (see above)
```

## Roadmap

### v0.3.0 - MCP Server Integration ✅ (Released)
- Direct Claude Code integration via MCP protocol
- HTTP/SSE transport for network access
- 5 debugging tools (get_logs, search_packets, status, etc.)
- Circular log buffer with client position tracking
- Optional bearer token authentication
- Cross-machine access (VM → Mac/Pi)

### v0.4.0 - Ultra-Simple Architecture ✅ (Released)
- Complete architectural refactor for extreme simplicity
- Atomic state machine preventing race conditions
- WebSocket as pure byte transport (no commands)
- Health checks and debugging via HTTP/MCP only
- 98%+ reliability for back-to-back connections
- Core bridge under 300 lines of code

### v0.5.0 - Secure Transport Support
- HTTPS support for MCP/health endpoints
- WSS (WebSocket Secure) for encrypted BLE tunneling
- TLS certificate configuration options
- Support for self-signed certificates in development

### v0.6.0 - OAuth Authentication
- OAuth 2.0 support for MCP endpoints
- Integration with popular OAuth providers
- JWT token validation
- Configurable authentication middleware

### v0.7.0 - CLI Tools
- `ble-mcp-test scan` - Scan for nearby BLE devices
- `ble-mcp-test test <device>` - Test connection to a device
- `ble-mcp-test monitor` - Live connection dashboard
- CLI as MCP client for enhanced capabilities

### v0.8.0 - Multi-Device Support
- Support multiple simultaneous BLE connections
- Route WebSocket clients to specific devices
- Connection pooling and management

### Future Considerations
- HTTP API for REST-based control
- Docker container for easy deployment
- Prometheus metrics export
- WebRTC data channel support for P2P connections


## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

If you're interested in working on any of the roadmap items, please open an issue to discuss first.

## License

MIT

---

**TODO**: Update all examples to use Nordic nRF52 UUIDs once the development board arrives. The nRF52 is a more accessible platform for developers ($40 vs $600+) and will make the examples reproducible for anyone wanting to try the bridge.