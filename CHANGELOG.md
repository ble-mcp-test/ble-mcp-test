# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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