# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2025-01-05

### BREAKING CHANGES
- **API Redesign**: `injectWebBluetoothMock()` now requires config object with sessionId, serverUrl, and service
  - **Old**: `injectWebBluetoothMock('ws://localhost:8080', { service: '9800' })`
  - **New**: `injectWebBluetoothMock({ sessionId: 'test-session', serverUrl: 'ws://localhost:8080', service: '9800' })`
  - `sessionId` is now **required** - no auto-generation to prevent session conflicts
  - `service` is now **required** - primary service UUID needed for device discovery
  - Clear error messages for missing required parameters
  - Flat config object structure eliminates parameter ordering issues

### Added
- **Comprehensive Error Validation**: Clear error messages for all missing required parameters
- **Enhanced TypeScript Support**: Full `WebBleMockConfig` interface with detailed parameter descriptions
- **Device Selection Options**: Added `deviceId`, `deviceName`, `timeout`, and `onMultipleDevices` parameters for device farm scenarios
- **JSDoc Documentation**: Added inline documentation with links to GitHub examples and docs
- **Unified Testing Approach**: Tests now auto-detect dev vs CI context - same tests work everywhere
- **Test Helpers**: Created shared helpers (setupMockPage, injectMockInPage, connectToDevice) to reduce boilerplate
- **Bundle Documentation**: Browser bundle includes helpful comments and links to GitHub resources

### Removed
- **Auto-generated Session IDs**: Eliminated confusion and unpredictable session behavior
- **Optional Parameters**: sessionId, serverUrl, and service are now required for explicit control

## [0.5.15] - 2025-09-05

### Fixed
- **Noble Zombie Fix Complete**: Achieved 100% reliable BLE connections (3/3 success)
  - completeNobleReset() now properly cleans up all Noble.js state on disconnect
  - Clears all cached peripherals, services, and characteristics
  - Removes all Noble event listeners preventing proper cleanup
  - Zombie test now passes with strict 3/3 success requirement
  - Fixed test configuration to use environment variables correctly

### Changed
- **CS108 Command Constants**: Centralized RFID reader commands for maintainability
  - Created cs108-commands module with getBatteryVoltageCommand() function
  - Replaced all duplicate battery command arrays across test files
  - Standardized command structure for future command additions
- **Improved Error Messages**: Zombie-specific error message for code 4002
  - Clear user guidance: "BLE zombie connection detected - restart ble-mcp-test service"

### Added
- CS108 command constants module at src/cs108-commands.ts
- Documentation for zombie detection and recovery patterns

## [0.5.14] - 2025-09-05

### Changed
- Updated changelog to include v0.5.13 entry that was missed during publish

## [0.5.13] - 2025-09-05

### Fixed
- **Atomic BLE Connection Validation**: WebSocket connections now only accepted after complete BLE stack validation
  - Eliminates phantom connections where WebSocket showed "connected" but BLE hardware was not connected
  - Complete validation sequence: Noble state → Device discovery → GATT connection → Service discovery → Characteristic discovery
  - WebSocket acceptance only occurs after all BLE operations successfully complete
  - Immediate session cleanup on any connection failure prevents zombie sessions
- **Application-Specific WebSocket Close Codes**: Proper error reporting with RFC 6455 compliant codes (4000-4999)
  - 4001: Hardware not found during scan
  - 4002: GATT connection failed  
  - 4003: Service not found
  - 4004: Characteristics not found
  - 4005: BLE disconnected during operation
- **Session Lifecycle Management**: Sessions immediately removed from manager on connection failure
  - No lingering sessions after failed connection attempts
  - Proper resource cleanup prevents accumulation of broken sessions

### Added
- BLE-specific error class `BLEConnectionError` for typed error handling
- Error mapping utilities to convert BLE errors to appropriate WebSocket close codes
- Connection state tracking to prevent cleanup during active connection attempts

### Changed
- Refactored BLE session connect() to validate entire stack atomically before creating transport
- Bridge server now waits for complete BLE validation before sending "connected" message
- WebSocket transport enhanced to handle and report application-specific close codes

## [0.5.12] - 2025-09-03

### Added
- **E2E Session Reuse**: Complete fix for Playwright test session management
  - Fixed session persistence across test runs for E2E automation
  - Session reuse now works properly with WebSocket connection pooling
  - All 40 E2E tests passing (100% success rate)
- **Node.js Transport Client**: Complete Web Bluetooth API implementation for Node.js environments
  - New `NodeBleClient` class provides Web Bluetooth API compatibility in Node.js
  - Enables integration testing against real hardware without browser dependency
  - Full support for requestDevice, GATT operations, and notifications
  - Compatible with existing WebSocket bridge server
  - Session management and reconnection support
  - Import as: `import { NodeBleClient } from 'ble-mcp-test/node'`
- **Millisecond Precision Logging**: TX/RX packets now show sub-second timing
  - Format: `[WSHandler] TX.123: A7 B3 C2...` where `.123` is milliseconds
  - Helps debug command timing and response latency
  - Minimal overhead - just 4 extra characters per log line
- **Roadmap Section**: Added development roadmap to README

### Fixed  
- **Force Cleanup Tech Debt**: Documented broken force cleanup functionality
  - Added honest warnings about force cleanup creating zombie connections
  - Server now uses normal disconnect instead of broken force cleanup
  - Provides actionable guidance for users experiencing issues
- **Battery Voltage Parsing**: Corrected endianness in test assertions
  - Fixed big-endian parsing: `(bytes[10] << 8) | bytes[11]`
  - Updated zombie reproduction test to report raw values correctly
- **Service UUID Extraction**: Mock now properly extracts service UUIDs from requestDevice filters
- **Systemd Service Installation**: Service now installs to `/opt/ble-bridge`

### Changed
- Package now exports separate entry points for browser and Node.js usage
- Consolidated duplicate zombie tests to single working implementation
- Simplified Noble disconnect handler (removed 25 lines of debug code)

## [0.5.11] - 2025-08-25

### Added
- Cross-platform UUID handling and session management improvements
  - Service files no longer depend on checkout location
- **Install Scripts**: Updated for robust systemd deployment
  - `install-service.sh`: Copies everything to `/opt/ble-bridge`
  - `uninstall-service.sh`: Properly cleans up installation
  - Start script automatically finds Node.js via fnm or system paths

### Changed
- Systemd service now runs from `/opt/ble-bridge` instead of user directory
- Service file includes proper environment for fnm-installed Node.js
>>>>>>> ffed5e3 (feat: improve systemd service installation and add millisecond logging)

## [0.5.10] - 2025-08-06

### Fixed
- **Bridge Server Version Check**: Fixed hardcoded version check in bridge-server.ts
  - Version check now dynamically reads from package.json
  - Eliminates false warnings about version mismatches
  - Bridge correctly validates mock version against current package version

## [0.5.9] - 2025-08-05

### Fixed
- **Mock Browser Entry Version**: Fixed hardcoded version in mock-browser-entry.ts
  - Version now uses build-time replacement like other modules
  - Ensures WebBleMock.version correctly reflects package version
  - Fixes version mismatch in bundled output

## [0.5.8] - 2025-08-05

### Added
- **Service UUID Filtering**: Device parameter is now optional - can connect by service UUID alone
  - Bridge accepts connections without device filter: `?service=9800&write=9900&notify=9901`
  - Noble scans with service UUID filter for efficiency
  - First device with matching service is connected
  - Enables more flexible device discovery following BLE best practices
  - Mock updated to handle empty device filters properly

- **Mock Version Detection**: Bridge warns when clients bypass the mock
  - Mock adds hidden `_mv` parameter to detect proper usage
  - Warning logged when direct WebSocket connections detected
  - Helps identify integration issues and outdated client bundles

- **Enhanced Disconnect Logging**: Track disconnect timeouts for zombie detection
  - Logs whether disconnect completed or timed out
  - Distinguishes between error recovery (5s timeout) and normal disconnect (10s timeout)
  - Shows exact time taken for disconnect operations

### Changed
- Updated documentation to clarify device parameter is optional
- Added "Common Mistakes" section warning against bypassing the mock
- E2E tests added for service-only filtering scenarios

### Fixed
- Mock no longer defaults to "MockDevice000000" when no device filter provided
- Empty device name handling throughout the stack

## [0.5.7] - 2025-08-03

### Fixed
- **Session ID Propagation**: Fixed critical bug where explicit sessionId was not being passed to WebSocket URL
  - Bug was in `mock-bluetooth.ts` line 185: checking wrong object after Object.assign
  - Changed from `this.device.bleConfig.sessionId` to `connectOptions.sessionId`
  - Ensures downstream E2E tests can use deterministic session IDs for Playwright testing
  - Added comprehensive E2E tests to verify session parameter in WebSocket URL

### Added
- **Platform-Aware UUID Normalization**: Bridge handles UUIDs correctly for each platform
  - **Linux**: Prefers short UUIDs - converts long standard UUIDs to short form
    - `"9800"` → `"9800"` (keeps short)
    - `"00009800-0000-1000-8000-00805F9B34FB"` → `"9800"` (shortens)
  - **macOS/Windows**: Requires full UUIDs - expands short to full format
    - `"9800"` → `"0000980000001000800000805f9b34fb"` (expands)
  - Handles both directions of conversion based on platform needs

### Fixed
- **Critical Noble Crash Prevention**: Comprehensive fix for crashes during BLE operations
  - Root cause: Connection errors were calling full `cleanup()` while Noble had active handles
  - Solution: Replaced with minimal reference cleanup that doesn't touch Noble internals
  - Added `connectInProgress` flag to prevent cleanup during active connections
  - Removed dangerous rfkill operations from automatic cleanup paths
  - Cleanup now safely returns early if called during connection attempt

- **Zombie Connection Detection**: Improved detection and handling
  - Session cleanup now verifies success before clearing state
  - Added 30-second grace period before marking connections as zombies
  - Fixed race condition where transport exists but deviceName not yet set
  - Failed cleanups no longer incorrectly mark sessions as disconnected

- **Noble Disconnect Reliability**:
  - Increased disconnect timeout from 2s to 10s for more reliable cleanup
  - Added disconnect verification to check peripheral state after disconnect
  - Added OS-level disconnect fallback using `hcitool ledc` when Noble fails (Linux only)
  - Block new connections during cleanup with user-friendly "BLE stack recovering" message

### Changed
- Made all OS-specific interventions conditional on `process.platform`
- Updated README to clarify platform-specific requirements
- Disabled resetStack in force cleanup to prevent crashes
- Added warnings about rfkill safety with Noble

## [0.5.6] - 2025-08-02

### Added
- **Comprehensive Timeout Stabilization**: Eliminate zombie connections and ensure robust connection lifecycle management
  - Enhanced Noble resource state verification with leak detection thresholds (scanStop <90, discover <10)
  - Device availability scanning after cleanup operations using check-device-available.js pattern
  - Progressive cleanup escalation (graceful → verified → aggressive → manual intervention)
  - Zombie session detection for sessions with transport but not properly connected
  - User notification capability when devices become unavailable
  - Comprehensive timeout stabilization integration tests
  - Testing environment configuration with shortened timeouts (5s grace, 10s idle vs 60s/300s production)

### Changed
- **Refactored Cleanup Architecture**: Consolidated redundant cleanup methods for simplicity
  - `NobleTransport.cleanup()` - Single unified method with configurable options (force, resetStack, verifyResources)
  - `BleSession.cleanup()` - Simplified to use transport's unified cleanup with progressive escalation
  - `SessionManager.checkStaleSessions()` - Streamlined zombie detection and resource verification
  - Reduced cleanup methods from 9+ scattered methods to 2 core methods
  - Removed redundant `performVerifiedCleanup()`, `verifySessionCleanup()`, and `triggerNobleReset()` methods

### Fixed
- **Noble Resource Leaks**: Automatic detection and cleanup of scanStop/discover listener accumulation
- **Zombie Connections**: Sessions with transport but no active connection are now properly detected and cleaned
- **Device Availability**: Cleanup operations now verify device is available for reconnection
- **Resource State Monitoring**: Noble peripheral cache and listener counts tracked throughout lifecycle

## [0.5.5] - 2025-08-01

### Added
- **Deterministic Session IDs for Playwright E2E Testing**: Hierarchical session ID generation strategy
  - Priority 1: `window.BLE_TEST_SESSION_ID` - Explicit injection by test
  - Priority 2: `process.env.BLE_TEST_SESSION_ID` - Environment variable
  - Priority 3: Playwright context detection - Auto-generate from test file path
  - Priority 4: Current random generation - Fallback for interactive use
- **Playwright Detection**: Automatic detection of Playwright environment
  - Checks for `PLAYWRIGHT_TEST_BASE_URL` environment variable
  - Checks for `window.__playwright` object
  - Detects Playwright in user agent string
- **Test Path Extraction**: Derives session ID from test file path in Playwright
  - Extracts test path from stack trace when Playwright context unavailable
  - Normalizes paths across platforms (Windows/Unix)
  - Creates deterministic format: `{hostname}-{test-path}`
- **New Utilities**:
  - `setTestSessionId(sessionId)` - Helper to set explicit test session ID
  - Enhanced logging for session ID generation decisions

### Fixed
- **E2E Test Session Conflicts**: Playwright tests no longer fail with "Device is busy with another session"
  - Each test file now gets a unique, deterministic session ID
  - Same test gets same session ID on retry
  - Different tests get different session IDs
- **Session Persistence in Tests**: Deterministic IDs ensure consistent sessions across page reloads
  - No more localStorage race conditions in E2E tests
  - Predictable session behavior for test debugging

### Changed
- **Backward Compatibility**: Interactive browser usage remains unchanged
  - Random session IDs still generated for non-test environments
  - localStorage persistence continues to work as before
  - No breaking changes to existing API

## [0.5.4] - 2025-08-01

### Fixed
- **Session Reuse Bug**: Fixed critical issue where reconnection to existing sessions during grace period was blocked
  - Enhanced session manager logging to better track session conflicts
  - Improved session reuse detection with proper grace period reconnection handling
  - Added race condition protection in MockBluetooth to prevent conflicting session IDs
  - Better WebSocket URL parameter parsing with detailed debugging logs
- **Idle Timeout Management**: Fixed competing timer issues between grace period and idle timeout
  - Idle timers are now properly cleared during grace periods to avoid conflicts
  - Enhanced timer coordination when WebSockets reconnect to existing sessions
  - Added stale session cleanup for sessions that exceed idle timeout + grace period
  - Improved WebSocket reconnection handling with proper idle timer reset

### Changed
- **Enhanced Debugging**: Comprehensive logging improvements across session management
  - SessionManager now provides detailed session status information
  - Bridge server logs full WebSocket connection parameters for troubleshooting
  - MockBluetooth includes race condition detection and localStorage consistency checks
- **Robust Timer Management**: Better coordination between grace period and idle timeout timers
  - No more competing timers that could cause inconsistent session cleanup
  - Proper timer state management during session state transitions

## [0.5.3] - 2025-08-01

### Added
- **Session Management Foundation**: Complete session-based architecture
  - Multi-session support with proper isolation and cleanup
  - Session persistence across WebSocket disconnections
  - Grace period and idle timeout management

## [0.5.2] - 2025-08-01

### Added
- **Session Persistence**: Sessions now persist across page reloads using localStorage
  - Auto-generated sessions are stored in `localStorage` and reused on page reload
  - Prevents test flakiness caused by random session IDs between test page reloads
  - Graceful fallback when localStorage is unavailable (private browsing, etc.)
- **Session Management Utility**: New `clearStoredSession()` function
  - Import and call to clear stored session when fresh session needed
  - Useful for test suite setup/teardown

### Changed
- **Session Generation**: Now checks localStorage first before generating new session
  - First injection stores session ID for reuse
  - Subsequent injections reuse stored session ID
  - Console logging shows when session is stored vs. reused

## [0.5.1] - 2025-08-01

### Fixed
- **Session Blocking Bug**: Fixed critical issue where new sessions were incorrectly rejected
  - Sessions with transport (connected or in grace period) now properly block new connections
  - New sessions receive proper error with `blocking_session_id` for debugging
- **Race Condition**: Fixed force_cleanup sending completion before cleanup was done
  - Cleanup operations now complete before acknowledgment is sent
- **Idle Timeout**: Fixed sessions not timing out after idle period
  - Corrected environment variable names (`BLE_SESSION_GRACE_PERIOD_SEC`)
  - Idle timeout now correctly based on TX activity only (not RX)

### Added
- **Simplified Session Management**: Zero-config auto-session generation
  - `injectWebBluetoothMock('ws://localhost:8080')` now auto-generates unique session IDs
  - Format: `{IP}-{browser}-{random}` (e.g., `192.168.1.100-chrome-A4B2`)
  - Different browsers/tools get automatic isolation
  - Same browser tabs share session (realistic BLE behavior)
- **Enhanced Cleanup Commands**: New cleanup options for E2E testing
  - `force_cleanup` with `all_sessions: true` cleans up all sessions for a device
  - New `admin_cleanup` command with auth token for test environments
  - Environment variable `BLE_ADMIN_AUTH_TOKEN` for admin command authentication
- **Force Takeover**: WebSocket URL parameter `force=true` for session takeover
  - Allows new session to forcibly disconnect existing session
  - Useful for development and testing scenarios
- **Session Blocking Info**: Error responses now include `blocking_session_id`
  - Helps identify which session is preventing connection
  - Improves debugging of session conflicts

### Changed
- **WSMessage Interface**: Extended with new fields for v0.5.1 features
  - `all_sessions`: Force cleanup all sessions for device
  - `blocking_session_id`: Session blocking the connection
  - `auth`: Auth token for admin commands
  - `action`: Admin action type

## [0.5.0] - 2025-08-01

### Added
- **Session Management Architecture**: Complete refactor of WebSocket-to-BLE bridge for session persistence
  - New `SessionManager` class manages BLE session lifecycle across WebSocket disconnects
  - New `WebSocketHandler` class handles individual WebSocket connections
  - Sessions persist during 60-second grace period after WebSocket disconnect
  - Support for multiple WebSockets per BLE session
  - Session IDs enable reconnection to existing BLE connections
- **Client-Side Session Support**: Web Bluetooth mock now supports session parameters
  - Pass `sessionId` to reuse existing session
  - Use `generateSession: true` for auto-generated session IDs
  - Session IDs included in WebSocket URL parameters
- **Backward Compatibility**: Works without session parameters for existing clients

### Changed
- **BREAKING: Architecture Refactor**: `BridgeServer` reduced from 301 to 104 lines
  - Now only handles HTTP server and WebSocket routing
  - All session logic moved to dedicated classes
  - Cleaner separation of concerns
- **BLE Session Enhancement**: Sessions now track grace periods and idle timeouts
  - Configurable via `BLE_SESSION_GRACE_PERIOD_SEC` and `BLE_SESSION_IDLE_TIMEOUT_SEC`
  - SharedState integration for connection status updates

### Fixed
- **Connection Reliability**: WebSocket disconnects no longer kill active BLE connections
- **Resource Management**: Proper cleanup of sessions on server shutdown
- **State Consistency**: Session status accurately tracked across components

## [0.4.5] - 2025-01-31

### Fixed
- **Connection Error Recovery**: Fixed race condition where timeout handler bypassed recovery period after errors
- **Error Code 22**: "Connection Terminated By Local Host" now properly triggers recovery period
- **Cleanup Race Conditions**: Unified all disconnect paths through single `disconnectCleanupRecover()` function
- **Stuck Inventory Disconnect**: Fixed bridge hanging in disconnecting state when CS108 streams inventory data during WebSocket close
  - Graceful disconnect with 750ms timeout, then force-close if stuck
  - Eliminates "Already disconnecting" errors and infinite RX loops

### Changed
- **Simplified Recovery**: Removed complex multi-level escalation logic, now uses single recovery period
- **Cleaner Architecture**: All disconnect scenarios (timeout, error, user, device) use same cleanup path
- **Force Disconnect Logic**: BLE cleanup now tries graceful first (250ms unsubscribe + 500ms disconnect), then forces connection close

## [0.4.4] - 2025-01-31

### Added
- **simulateNotification Testing**: Multi-connect test now validates both real device responses and simulated notifications with fake battery values (9999mV)
- **Timestamp Logging**: Optional timestamps in logs (HH:MM:SS.mmm format) via `BLE_MCP_LOG_TIMESTAMPS`
- **Bluetooth Error Translation**: Numeric error codes now translated to meaningful messages (e.g., 62 = "Connection timed out")
- **Better Error Logging**: Improved error handling for undefined errors and full error object logging

### Fixed
- **CRITICAL: Resource Leak**: Fixed timeout state management bug causing bridge to get stuck in 'connecting' state under sustained load
- **CRITICAL: Zombie BLE Connections**: Force disconnect peripherals on ANY error to prevent device staying connected
- **Mock Notification Race Conditions**: Fixed notification handling in Web Bluetooth mock to prevent hanging responses
- **Timeout Pattern**: Refactored timeout handling to use clean utility pattern, moved to utils.ts for reuse
- **Undefined Error Messages**: Safely extract error messages from any error type
- **Stuck Device State**: Ensure BLE device disconnects even when connection errors occur
- **Error Code 62**: Now properly translated as "Connection timed out (ETIMEDOUT)"

### Changed
- **NPM Publish**: Now only runs Playwright E2E tests instead of all tests
- **Error Recovery**: More aggressive cleanup when connection errors occur

## [0.4.3] - 2025-01-31

### Changed
- **Faster Test Recovery**: Clean disconnects now recover in 1s instead of 5s
- **Mock Retry Defaults**: Increased retries (20) and gentler backoff (1.3x) for better test resilience
- **Mock Post-Disconnect Delay**: Now 1s to match server recovery timing

### Added
- **Multi-Cycle Playwright Test**: Verifies mock handles rapid connect/disconnect cycles

### Fixed
- Test suites no longer need to wait 5s between test files
- Mock retry timing now intelligently matches server recovery behavior

## [0.4.2] - 2025-01-31

### Fixed
- **Critical Bundle Export Issue**: Browser bundle now properly exposes `window.WebBleMock` global

### Added
- **Playwright Tests**: Verify bundle works before release
- **Build Script**: Custom browser bundle build with proper exports

### Changed
- Browser bundle build process now uses dedicated entry point

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