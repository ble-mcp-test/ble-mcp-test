# BLE WebSocket Bridge v2.0 - State Machine & Resource Management Refactor

## Pre build cycle steps
- Start a new refactor branch
- Apply version 0.4.0 to package.json

## Post build cycle steps
- Comprehensively review all tests to ensure that they align to refactored service code
- Ensure that full test suite can run in under 2 minutes
- Update README.md and any other project documentation to align to refactored architecture and workflow

## Project Overview

**Project Name**: BLE WebSocket Bridge v0.4.0 - State Machine & Resource Management Refactor  
**Version**: 2.0  
**Date**: July 30, 2025  
**Status**: Requirements Phase

### Current State
The existing BLE WebSocket Bridge suffers from race conditions, resource leaks, and lacks proper connection state management. Multiple clients can attempt simultaneous connections, leading to undefined behavior and potential crashes.

### Objective
Implement a robust state machine architecture with proper resource management, connection control, and client idle timeout handling to ensure reliable single-client operation.

## 1. FUNCTIONAL REQUIREMENTS

### 1.1 Server State Machine

**REQ-1.1.1**: State Machine Implementation
- The system SHALL implement a StateMachine class with three states: IDLE, ACTIVE, EVICTING
- State transitions SHALL be: IDLE ↔ ACTIVE → EVICTING → IDLE
- Invalid state transitions SHALL be rejected with descriptive errors
- Current state SHALL be exposed in health endpoint responses

**REQ-1.1.2**: State Transition Logic
- IDLE state: No active BLE connections, ready to accept new connections
- ACTIVE state: BLE connection established, normal operation mode
- EVICTING state: Client idle timeout triggered, 5-second grace period active
- State changes SHALL be logged for debugging and monitoring

### 1.2 Connection Management System

**REQ-1.2.1**: ConnectionContext Implementation
- The system SHALL implement a ConnectionContext class to encapsulate per-connection state
- Each successful BLE connection SHALL create a new ConnectionContext instance
- ConnectionContext SHALL manage: token, idle timer, cleanup state, WebSocket reference
- ConnectionContext SHALL be the single source of truth for connection lifecycle

**REQ-1.2.2**: Token Management
- Connection tokens SHALL be generated using crypto.randomUUID() (simple UUID v4)
- Tokens SHALL be generated only upon successful BLE connection establishment
- Tokens SHALL be included in the 'connected' message: `{"type": "connected", "device": "...", "token": "uuid"}`
- Tokens SHALL be stored in-memory only (no persistence across server restarts)
- No token validation required for regular operations (trust model)

**REQ-1.2.3**: ConnectionMutex Implementation
- The system SHALL implement ConnectionMutex class for single-connection enforcement
- ConnectionMutex SHALL use atomic claim/release operations to prevent race conditions
- Only one connection token SHALL hold the mutex at any time
- Failed mutex claims SHALL immediately reject new connection attempts

**REQ-1.2.4**: Mutex Integration
- BridgeServer SHALL use connectionMutex.tryClaimConnection() before BLE connection attempts
- ConnectionContext SHALL automatically release mutex on cleanup
- Force cleanup operations SHALL validate token ownership before proceeding
- Mutex state SHALL be queryable for health checks and debugging

### 1.3 Client Activity Tracking and Idle Timeout

**REQ-1.3.1**: Activity Classification
- The following client messages SHALL reset the idle timer:
  - `data` (client sending data to device)
  - `disconnect` (client requesting disconnect)
  - `cleanup` (client requesting cleanup)
  - `force_cleanup` (client forcing cleanup)
  - `check_pressure` (client checking pressure)
  - `keepalive` (new explicit keepalive message)
  - Any future client-initiated message types

**REQ-1.3.2**: Non-Activity Messages
- The following messages SHALL NOT reset the idle timer:
  - `connected` (server confirming connection)
  - `disconnected` (server reporting disconnection)
  - `data` from server (forwarding device notifications)
  - `error` (server reporting errors)
  - `eviction_warning` (server timeout warning)
  - Health checks and status queries

**REQ-1.3.3**: Timeout Configuration
- Client idle timeout SHALL be configured globally via CLIENT_IDLE_TIMEOUT environment variable
- Default timeout SHALL be 45000ms (45 seconds)
- All connections SHALL use the same timeout value (no per-connection configuration)
- Timeout value SHALL be logged on server startup

**REQ-1.3.4**: Timer Management
- Idle timer SHALL start immediately after successful BLE connection
- Timer reset SHALL occur on ANY qualifying client activity
- Timer SHALL be cancelled when connection ends normally
- Timer precision SHALL be ±1 second (no sub-second requirements)

### 1.4 Eviction and Force Cleanup System

**REQ-1.4.1**: Eviction Warning Protocol
- Server SHALL send eviction warning 5 seconds before forced cleanup
- Warning message: `{"type": "eviction_warning", "grace_period_ms": 5000, "reason": "idle_timeout"}`
- Client MAY respond with keepalive message to cancel eviction
- If no client response within grace period, server SHALL proceed with forced cleanup

**REQ-1.4.2**: Token-Based Force Cleanup
- Force cleanup operations SHALL require valid connection token
- Cleanup commands SHALL include token: `{"type": "force_cleanup", "token": "uuid"}`
- Server SHALL validate token before executing force cleanup
- Invalid tokens SHALL result in immediate error response

**REQ-1.4.3**: Cleanup Levels
- **disconnect**: Graceful BLE disconnection with proper cleanup
- **cleanup**: Complete BLE cleanup (unsubscribe + disconnect)
- **force_cleanup**: Token-validated forced cleanup with Noble.js reset
- Each level SHALL perform all operations of lower levels
- Cleanup operations SHALL be idempotent (safe to call multiple times)

### 1.5 New Message Types

**REQ-1.5.1**: Keepalive Protocol
- Client SHALL be able to send `{"type": "keepalive"}` to reset idle timer
- Server SHALL respond with `{"type": "keepalive_ack", "timestamp": "..."}`
- Keepalive messages SHALL have no side effects beyond timer reset
- Keepalive frequency is client discretion (no server requirements)

**REQ-1.5.2**: Enhanced Connected Message
- Connected message SHALL include connection token
- Format: `{"type": "connected", "device": "DeviceName", "token": "uuid-v4-string"}`
- Token SHALL be required for force cleanup operations
- Connection establishment timestamp SHALL be included

### 1.6 Backward Compatibility

**REQ-1.6.1**: Breaking Changes Allowed
- This release SHALL be a breaking change requiring coordinated client/server upgrades
- Existing clients without token support SHALL be rejected with clear error messages
- New connection protocol SHALL be mandatory (no fallback to old protocol)
- Version mismatch detection SHOULD be implemented for clear error reporting

**REQ-1.6.2**: Migration Strategy
- Server upgrade SHALL be coordinated with client library updates
- Clear migration documentation SHALL be provided
- Breaking changes SHALL be clearly documented in release notes
- No gradual migration support required

## 2. NON-FUNCTIONAL REQUIREMENTS

### 2.1 Performance Requirements

**REQ-2.1.1**: Connection Performance
- Connection establishment SHALL complete within 30 seconds under normal conditions
- Idle timeout checking SHALL not impact normal data throughput
- State transitions SHALL complete within 100ms
- Resource cleanup SHALL not block new connection attempts

**REQ-2.1.2**: Resource Management
- Memory usage SHALL remain stable during extended operation
- Event listener accumulation SHALL be prevented through proper cleanup
- Noble.js pressure monitoring SHALL continue to function
- System SHALL handle 1000+ connection/disconnection cycles without degradation

### 2.2 Reliability Requirements

**REQ-2.2.1**: Error Handling
- All state machine transitions SHALL be validated and logged
- Connection failures SHALL not leave system in inconsistent state
- Resource cleanup SHALL be atomic and complete
- Error messages SHALL be descriptive and actionable

**REQ-2.2.2**: Recovery Capabilities
- System SHALL recover from unexpected BLE disconnections
- Force cleanup SHALL restore system to clean IDLE state
- Noble.js listener pressure SHALL be monitored and managed
- Connection state SHALL be accurately tracked and reported

### 2.3 Monitoring and Debugging

**REQ-2.3.1**: State Visibility
- Current state SHALL be queryable via health endpoint
- Connection token and activity timestamps SHALL be exposed
- State transition history SHALL be logged for debugging
- Resource pressure metrics SHALL be available

**REQ-2.3.2**: Logging Requirements
- All state changes SHALL be logged with timestamps
- Connection lifecycle events SHALL be tracked
- Cleanup operations SHALL log detailed progress
- Debug logging SHALL not impact performance

## 3. TECHNICAL REQUIREMENTS

### 3.1 Architecture Components

**REQ-3.1.1**: ConnectionContext Class
- Manage connection token, idle timer, and cleanup state
- Provide interface for activity tracking and timeout handling
- Handle WebSocket reference and message routing
- Ensure proper cleanup when connection ends

**REQ-3.1.2**: ConnectionMutex Class
- Implement atomic claim/release operations
- Track active connection token
- Prevent race conditions during connection setup
- Provide queryable state for debugging

**REQ-3.1.3**: StateMachine Class
- Manage IDLE/ACTIVE/EVICTING state transitions
- Validate state changes and reject invalid transitions
- Provide current state information
- Log all state changes with context

**REQ-3.1.4**: Enhanced BridgeServer
- Integrate all new components seamlessly
- Route messages through ConnectionContext for activity tracking
- Handle special connection URLs without affecting main flow
- Maintain existing MCP and logging functionality

### 3.2 Message Protocol Updates

**REQ-3.2.1**: Updated WebSocket API
```
Outgoing messages (client -> server):
- { type: 'data', data: number[] } - Send data to BLE device (resets timer)
- { type: 'disconnect' } - Disconnect from BLE device gracefully (resets timer)
- { type: 'cleanup' } - Perform complete BLE cleanup (resets timer)
- { type: 'force_cleanup', token: string } - Token-validated force cleanup (resets timer)
- { type: 'check_pressure' } - Get Noble.js listener pressure metrics (resets timer)
- { type: 'keepalive' } - Reset idle timer without side effects (resets timer)

Incoming messages (server -> client):
- { type: 'connected', device: string, token: string } - Connected with token
- { type: 'disconnected' } - Disconnected from BLE device
- { type: 'data', data: number[] } - Data received from BLE device
- { type: 'error', error: string } - Error occurred
- { type: 'cleanup_complete', message: string } - Cleanup completed
- { type: 'force_cleanup_complete', message: string } - Force cleanup completed
- { type: 'pressure_report', pressure: object } - Listener pressure metrics
- { type: 'health', status: string, free: boolean, state: string, ... } - Health check
- { type: 'eviction_warning', grace_period_ms: number, reason: string } - Timeout warning
- { type: 'keepalive_ack', timestamp: string } - Keepalive acknowledgment
```

**REQ-3.2.2**: Environment Variables
```
CLIENT_IDLE_TIMEOUT=45000          # Client idle timeout in milliseconds
WS_PORT=8080                       # WebSocket server port
BLE_CONNECTION_STABILITY=0         # Existing BLE timing configs
BLE_PRE_DISCOVERY_DELAY=0          # (all existing variables remain)
... (other existing BLE timing variables)
```

### 3.3 Integration with Existing Code

**REQ-3.3.1**: NobleTransport Integration
- NobleTransport.tryClaimConnection() SHALL integrate with ConnectionMutex
- NobleTransport.performCompleteCleanup() SHALL be called by ConnectionContext
- Existing cleanup levels (disconnect, cleanup, force_cleanup) SHALL be preserved
- NobleTransport pressure monitoring SHALL continue to work unchanged

**REQ-3.3.2**: Preserved Functionality
- MCP tools integration SHALL remain fully functional
- Log streaming and health check endpoints SHALL work unchanged
- Device scanning capabilities SHALL be preserved
- Existing timing configuration and environment variables SHALL work

## 4. IMPLEMENTATION PHASES

### Phase 1: Core Infrastructure
- Implement StateMachine, ConnectionMutex, and ConnectionContext classes
- Basic integration with BridgeServer
- Update message handling for activity tracking
- Add environment variable configuration

### Phase 2: Idle Timeout System
- Implement client activity tracking and idle timer
- Add eviction warning protocol
- Create keepalive message handling
- Integrate timeout management with ConnectionContext

### Phase 3: Token System & Force Cleanup
- Add token generation and management
- Implement token-validated force cleanup
- Update connected message format
- Add proper error handling for invalid tokens

### Phase 4: Integration & Testing
- Complete integration with existing NobleTransport logic
- Comprehensive testing of all scenarios
- Performance optimization and monitoring
- Documentation and migration guide

## 5. DELIVERABLES

### 5.1 Code Deliverables
- ConnectionContext class with full lifecycle management
- ConnectionMutex class with atomic operations
- StateMachine class with proper state management
- Enhanced BridgeServer with complete integration
- Updated message protocol implementation
- Comprehensive test suite covering all scenarios

### 5.2 Documentation Deliverables
- Updated API documentation with new message types
- Migration guide for existing clients
- State machine diagram and behavior documentation
- Troubleshooting guide for common issues
- Performance benchmarking results

### 5.3 Configuration Deliverables
- Environment variable documentation
- Default configuration recommendations
- Deployment checklist for breaking changes
- Monitoring and alerting recommendations

## 6. SUCCESS CRITERIA

### 6.1 Functional Success
- [ ] No race conditions during concurrent connection attempts
- [ ] Proper client idle timeout with configurable duration
- [ ] Token-based force cleanup working reliably
- [ ] All state transitions working correctly
- [ ] Complete resource cleanup preventing memory leaks

### 6.2 Performance Success
- [ ] Connection establishment within 30 seconds
- [ ] No performance degradation during normal operation
- [ ] System stable after 1000+ connect/disconnect cycles
- [ ] Memory usage remains constant during extended operation

### 6.3 Integration Success
- [ ] All existing MCP tools continue to work
- [ ] Noble.js pressure monitoring functional
- [ ] Log streaming and health checks working
- [ ] Device scanning capabilities preserved
- [ ] Existing timing configurations respected

This comprehensive requirements document provides clear guidance for implementing a robust v0.4.0 refactor with proper state management, connection control, and client idle timeout handling.

[1] https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/22037258/e31bb8b1-48fa-49a0-b28a-ceab5bf524a9/bridge-server.ts
[2] https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/22037258/3e0c762e-d336-4db0-b8d8-74ae056ccf23/mock-bluetooth.ts
[3] https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/22037258/83c5a34e-6af7-4d9c-8d90-3588c3082578/noble-transport.ts
