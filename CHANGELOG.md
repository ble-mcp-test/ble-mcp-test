# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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