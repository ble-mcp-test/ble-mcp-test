# Web-BLE-Bridge CLI Specification

## Overview

A command-line interface for web-ble-bridge that makes it easy to start the bridge server, scan for devices, test connections, and debug BLE communications without writing code.

## Commands

### `web-ble-bridge start`
Start the WebSocket-to-BLE bridge server.

```bash
web-ble-bridge start [options]

Options:
  -p, --port <number>      Port to listen on (default: 8080)
  -l, --log-level <level>  Log level: error, info, debug (default: info)
  -h, --host <address>     Host to bind to (default: localhost)
  --no-startup-scan        Skip startup BLE functionality scan
```

Example:
```bash
web-ble-bridge start --port 3000 --log-level debug
```

### `web-ble-bridge scan`
Scan for nearby BLE devices.

```bash
web-ble-bridge scan [options]

Options:
  -d, --duration <ms>      Scan duration in milliseconds (default: 5000)
  -f, --filter <prefix>    Filter by device name prefix
  --json                   Output as JSON
```

Example:
```bash
web-ble-bridge scan --duration 10000 --filter CS108
```

### `web-ble-bridge test`
Test connection to a BLE device and optionally send commands.

```bash
web-ble-bridge test [options]

Options:
  -d, --device <prefix>    Device name prefix (required)
  -s, --service <uuid>     Service UUID (default: auto-detect)
  -w, --write <uuid>       Write characteristic UUID
  -n, --notify <uuid>      Notify characteristic UUID
  -c, --command <hex>      Send hex command after connecting
  -f, --file <path>        Read commands from file (one per line)
  --cs108                  Use CS108 presets (service: 9800, write: 9900, notify: 9901)
  --expect <hex>           Expected response pattern (supports wildcards)
  --repeat <n>             Repeat command n times
  --delay <ms>             Delay between commands (default: 100)
  --timeout <ms>           Connection timeout (default: 15000)
  -u, --url <ws://...>     Bridge server URL (default: ws://localhost:8080)
  --save <name>            Save device config for future use
```

Example:
```bash
# Test connection only
web-ble-bridge test --device CS108

# Test with CS108 battery command
web-ble-bridge test --cs108 --device CS108 --command A7B302D98237000A000

# Test expecting specific response
web-ble-bridge test --cs108 --device CS108 \
  --command A7B302D98237000A000 \
  --expect A7B304****A000****

# Batch test from file
web-ble-bridge test --cs108 --device CS108 --file commands.txt

# Stress test
web-ble-bridge test --cs108 --device CS108 \
  --command A7B302D98237000A000 \
  --repeat 100 --delay 500

# Test remote bridge
web-ble-bridge test --url ws://192.168.1.100:8080 --device CS108
```

Output shows:
- Connection status with timing
- Service/characteristic discovery
- Command sent (hex + ASCII if printable)  
- Response received (hex + ASCII if printable)
- Response validation if --expect used
- Performance metrics (round-trip time)

### `web-ble-bridge logs`
Stream logs from a local or remote bridge server via WebSocket.

```bash
web-ble-bridge logs [options]

Options:
  -u, --url <ws://...>     WebSocket URL (default: ws://localhost:8080)
  -l, --level <level>      Filter log level: error, info, debug
  --hex                    Show data packets as hex
  --no-color              Disable colored output
  --since <time>           Show logs since time (ISO timestamp or duration: '30s', '5m', '1h')
  --follow                 Follow log output (default: true)
  --json                   Output as newline-delimited JSON
```

Note: The bridge server maintains logs in a circular buffer (no persistence).
Logs are available only while the server is running.

Example:
```bash
# Local logs
web-ble-bridge logs --level debug

# Remote server logs
web-ble-bridge logs --url ws://192.168.1.100:8080 --hex

# Show last 30 seconds
web-ble-bridge logs --since 30s --no-follow

# Pipe to file for persistence
web-ble-bridge logs --json > ble-session.log
```

Shows:
- Connection/disconnection events
- Data packets (TX/RX) with timestamps
- Noble transport events
- Errors and warnings
- Resource pressure indicators

### `web-ble-bridge monitor`
Real-time dashboard showing connection status and metrics.

```bash
web-ble-bridge monitor [options]

Options:
  -u, --url <ws://...>     WebSocket URL (default: ws://localhost:8080)
  --refresh <ms>           Refresh interval (default: 1000)
```

Shows:
- Active connections count
- Data throughput (bytes/sec)
- Connection duration
- Last activity timestamps
- Resource pressure gauge

### `web-ble-bridge generate`
Generate example code for using the bridge.

```bash
web-ble-bridge generate [options]

Options:
  -l, --language <lang>    Language: javascript, typescript, python (default: javascript)
  -d, --device <type>      Device type: cs108, nrf52, generic (default: generic)
  -o, --output <file>      Output file (default: stdout)
```

Example:
```bash
web-ble-bridge generate --language typescript --device cs108 > cs108-example.ts
```

### `web-ble-bridge doctor`
Check system compatibility and Noble.js installation.

```bash
web-ble-bridge doctor

Checks:
- Node.js version compatibility
- Noble.js installation and permissions
- Bluetooth adapter status
- Platform-specific requirements
```

## Global Options

```bash
-V, --version     Show version number
-h, --help        Show help
--config <file>   Load configuration from file
```

## Configuration File

Support for `.web-ble-bridge.json` configuration:

```json
{
  "server": {
    "port": 8080,
    "host": "localhost",
    "logLevel": "info"
  },
  "ble": {
    "scanTimeout": 15000,
    "connectionTimeout": 15000,
    "disconnectCooldown": 200
  },
  "devices": {
    "cs108": {
      "service": "9800",
      "write": "9900",
      "notify": "9901"
    }
  }
}
```

## Interactive Mode

```bash
web-ble-bridge interactive
```

Provides a REPL-like interface for:
- Scanning devices
- Connecting/disconnecting
- Sending commands
- Viewing logs
- All without restarting

## Use Cases

### Development Workflow
```bash
# Start bridge in one terminal
web-ble-bridge start --log-level debug

# In another terminal, scan for your device
web-ble-bridge scan --filter MyDevice

# Test connection
web-ble-bridge test --device MyDevice

# Generate starter code
web-ble-bridge generate --device generic > my-app.js
```

### CI/CD Integration
```bash
# Start bridge in background
web-ble-bridge start --port 8080 &
BRIDGE_PID=$!

# Run tests
npm test

# Cleanup
kill $BRIDGE_PID
```

### Debugging
```bash
# Monitor all traffic
web-ble-bridge monitor --hex

# Test specific commands
web-ble-bridge test --device CS108 --command A7B302D98237000A000 --timeout 5000
```

## Implementation Notes

1. **Dependencies**:
   - `commander` - CLI framework
   - `chalk` - Colored output
   - `ora` - Progress spinners
   - `inquirer` - Interactive prompts
   - `ws` - WebSocket client for monitor/test commands

2. **Architecture**:
   - Reuse existing bridge modules
   - Commands communicate via WebSocket when needed
   - Standalone commands (scan, doctor) use Noble directly

3. **Error Handling**:
   - Clear error messages with suggestions
   - Non-zero exit codes for scripting
   - --json flag for machine-readable output

4. **Future Enhancements**:
   - Record/replay functionality
   - Protocol analyzer
   - Performance benchmarking
   - Device simulation mode