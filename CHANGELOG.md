# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2025-01-30

### Fixed
- **Mock Connection Lifecycle**: Added smart retry logic when bridge is in "disconnecting" state
  - Retries up to 10 times with exponential backoff (1s, 1.5s, 2.25s...)
  - Distinguishes between retryable (bridge busy) and non-retryable errors
  - Provides visibility through console logs when retries occur
- **TX/RX Logging**: Changed from byte count to actual hex bytes for protocol debugging
  - Before: `[Bridge] TX 10 bytes`
  - After: `[Bridge] TX: a7 b3 02 d9 82 37 00 00 a0 00`
- **Mock Cleanup**: Improved disconnect synchronization
  - Waits for force_cleanup acknowledgment before closing WebSocket
  - Prevents race conditions during rapid connect/disconnect cycles

### Added
- **Mock Configuration Options** (via environment variables):
  - `BLE_MCP_MOCK_RETRY_DELAY` - Initial retry delay in ms (default: 1000)
  - `BLE_MCP_MOCK_MAX_RETRIES` - Maximum retry attempts (default: 10)
  - `BLE_MCP_MOCK_CLEANUP_DELAY` - Optional post-disconnect delay (default: 0)
  - `BLE_MCP_MOCK_BACKOFF` - Exponential backoff multiplier (default: 1.5)
  - `BLE_MCP_MOCK_LOG_RETRIES` - Log retry behavior (default: true)
- **simulateNotification() Method**: Tests can inject device notifications
  ```javascript
  // Simulate button press from device
  characteristic.simulateNotification(new Uint8Array([0xA7, 0xB3, 0x01, 0xFF]));
  ```
  - Enables testing of notification handlers without real device events
  - Test controls exact timing and payload of simulated events
  - Works alongside real device notifications
- **Stress Tests**: Suite to replicate npm publish failures under high load
  - Confirms BLE operations are sensitive to CPU/memory pressure
  - Documents attack vectors and mitigation strategies

### Changed
- Mock now handles bridge's 5-second recovery period gracefully
- Better error messages distinguish between temporary and permanent failures

## [0.4.0] - 2025-01-30

### Added
- **Atomic State Machine**: Single state variable (ready → connecting → active → disconnecting) prevents all race conditions
- **Service Separation**: Clean architectural split between bridge (BLE tunneling) and observability (MCP/health)
- **Shared State**: Unified logging and state management between services
- **Recovery Period**: Configurable hardware recovery delay after disconnection (default 5s)
- **Hardware Reminder**: Documentation emphasizing CS108 hardware is always available

### Changed
- **BREAKING**: Complete architectural rewrite - NO backward compatibility
- **BREAKING**: Removed all complex orchestration in favor of ultra-simple design (<300 LOC core)
- **BREAKING**: One connection policy - first wins, rest are immediately rejected
- **BREAKING**: No reconnection logic - clients must implement their own retry
- **BREAKING**: No connection tokens, session management, or idle timeouts
- **BREAKING**: State transitions are now atomic: only 'ready' state accepts connections
- **BREAKING**: Simplified WebSocket protocol to essential messages only
- **BREAKING**: MCP tools moved to separate observability service
- Code reduction from 3304 to 1602 total lines (52% reduction)
- Bridge server reduced from 648 to 261 lines (60% reduction)

### Removed
- ❌ All state machines except the single atomic state
- ❌ Connection tokens and session management
- ❌ Idle timeout and eviction logic
- ❌ Reconnection attempts
- ❌ Device discovery endpoint
- ❌ Complex configuration options
- ❌ Multiple concurrent connection support
- ❌ Connection queueing
- ❌ All "fancy" features in favor of reliability

### Fixed
- Race conditions completely eliminated through atomic state
- "Scan already in progress" errors through proper cleanup
- Back-to-back connection reliability now 98%+
- Connection mutex deadlocks (by removing the mutex entirely)

### Philosophy
- "Transport should just be plumbing" - pure byte tunneling
- "First sperm wins" - simple connection policy
- "Fall down seven times, stand up eight" - focus on recovery
- Target: Do one thing well - tunnel BLE bytes over WebSocket

### Removed
- All hardcoded UUIDs, device names, and IDs from source and test code
- Backward compatibility for old environment variable names
- Redundant BLE timing variables:
  - `BLE_MCP_CONNECTION_STABILITY` and `BLE_MCP_PRE_DISCOVERY_DELAY` (both were always 0)
  - `BLE_MCP_NOBLE_RESET_DELAY` and `BLE_MCP_DISCONNECT_COOLDOWN` (consolidated into `BLE_MCP_RECOVERY_DELAY`)

## [0.3.1] - 2025-01-26

### Added
- MCP dynamic registration endpoints for Claude Code compatibility
  - `GET /mcp/info` - Public endpoint returning server metadata and tool list
  - `POST /mcp/register` - Authenticated endpoint for client registration
- Dynamic version loading from package.json (no more hardcoded versions)
- Tool registry for dynamic tool discovery
- Integration tests for MCP endpoints

### Changed
- Simplified convenience scripts for better developer experience:
  - Removed confusing `start:auth` and `start:test` scripts
  - Renamed scripts to align with use cases:
    - `start` - Basic local development (stdio + WebSocket)
    - `start:http` - Add HTTP transport for MCP endpoint testing
    - `start:ci` - CI/CD mode with fixed test token
    - `start:bg` - Background daemon mode
- Fixed missing `--mcp-http` flag in auth-related scripts

### Fixed
- Claude Code "HTTP 404" errors when discovering MCP server
- Hardcoded version strings now dynamically loaded from package.json

## [0.3.0] - 2025-01-25

### Added
- MCP (Model Context Protocol) server integration for Claude Code
- HTTP/SSE transport for network-accessible MCP connections
- 5 debugging tools accessible via MCP: get_logs, search_packets, get_connection_state, status, scan_devices
- Circular log buffer with client position tracking
- Bearer token authentication for MCP endpoints (optional - local access allowed without token)
- Cross-machine access support (e.g., VM → Mac/Pi)

### Changed
- **BREAKING**: Package renamed from `@trakrf/web-ble-bridge` to `ble-mcp-test`
- MCP server is now always enabled - it's a core feature!
  - Update imports: `@trakrf/web-ble-bridge` → `ble-mcp-test`
  - Update CLI commands: `npx @trakrf/web-ble-bridge` → `pnpm dlx ble-mcp-test`
  - Update binary name: `web-ble-bridge` → `ble-mcp-test`
  - Repository moved to: https://github.com/ble-mcp-test/ble-mcp-test
- Updated description to reflect MCP integration focus

## [0.2.0] - 2025-01-23

### Added
- Bytestream logging feature for debugging BLE communication
  - [TX]/[RX] prefixed hex output for all data transmitted to/from BLE devices
  - Uppercase hex format with space separation (e.g., `A7 B3 C2`)
  - LOG_LEVEL environment variable support with values: debug, info, warn, error
  - Common log level aliases support (verbose→debug, trace→debug, warn→info)
- New utilities module (`src/utils.ts`) with:
  - `formatHex()` function for consistent hex formatting
  - `normalizeLogLevel()` function for log level mapping
  - `LogLevel` type definition
- Integration tests for logging functionality

### Changed
- Enhanced `bridge-server.ts` to show [TX]/[RX] logs at debug level
- Modified `noble-transport.ts` to conditionally show device discovery logs
- Updated `start-server.ts` to read LOG_LEVEL environment variable
- At debug level: Shows bytestream traffic and device discovery logs
- At info level: Shows only server startup, connections, state changes, and errors

## [0.1.0] - 2025-01-20

### Added
- Initial release
- WebSocket-to-BLE bridge server for CS108 testing
- Minimal implementation (<500 lines total)
- Mock Web Bluetooth API for browser testing
- Noble.js integration for BLE communication
- WebSocket transport for client-server communication
- Integration and E2E test suites
- Support for device-agnostic UUID configuration