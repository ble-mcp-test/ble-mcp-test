# ble-mcp-test Architecture

## Overview

ble-mcp-test is designed around extreme simplicity. The core bridge components total under 1000 lines, implementing a minimal WebSocket-to-BLE bridge with Web Bluetooth API mocking.

## Core Components

### 1. Bridge Server (`bridge-server.ts`)
- **Purpose**: WebSocket server that tunnels BLE commands
- **Lines**: ~440
- **State Machine**: `ready → connecting → active → disconnecting`
- **Key Features**:
  - One connection at a time (prevents race conditions)
  - Atomic state transitions
  - 5-second recovery period after disconnection
  - Escalating cleanup system for stuck states

### 2. Noble Transport (integrated in bridge-server.ts)
- **Purpose**: Direct Noble.js usage for BLE operations
- **Lines**: Integrated into bridge
- **Responsibilities**:
  - Device scanning and connection
  - Service/characteristic discovery
  - Data read/write operations
  - Notification handling

### 3. Web Bluetooth Mock (`mock-bluetooth.ts`)
- **Purpose**: Drop-in replacement for navigator.bluetooth
- **Lines**: ~370
- **Features**:
  - Implements Web Bluetooth API surface
  - Forwards calls to bridge via WebSocket
  - Automatic retry logic for busy states
  - Test notification injection

### 4. WebSocket Transport (`ws-transport.ts`)
- **Purpose**: Client-side WebSocket communication
- **Lines**: ~150
- **Handles**:
  - Connection management
  - Message serialization
  - Error handling
  - Force cleanup requests

## State Management

### Bridge State Machine

```
         ┌─────────┐
         │  ready  │◄────────────┐
         └────┬────┘             │
              │                  │ 5s recovery
              │ connect          │
         ┌────▼────┐             │
         │connecting│            │
         └────┬────┘             │
              │                  │
              │ success          │
         ┌────▼────┐             │
         │ active  │             │
         └────┬────┘             │
              │                  │
              │ disconnect       │
         ┌────▼──────┐           │
         │disconnecting├─────────┘
         └───────────┘
```

### Escalating Cleanup System

The bridge implements a 3-level cleanup system for stuck "disconnecting" states:

1. **Level 1 (3s)**: Gentle cleanup - clear timers, attempt graceful disconnect
2. **Level 2 (8s)**: Aggressive cleanup - force Noble disconnect, clear all state
3. **Level 3 (13s)**: Nuclear option - hard reset everything, force ready state

## Protocol Design

### WebSocket JSON Protocol

Simple request/response + event streaming:

```typescript
// Client → Server
{ type: 'data', data: number[] }           // Send data to device
{ type: 'force_cleanup', token?: string }  // Request cleanup

// Server → Client  
{ type: 'connected', device: string, token: string }
{ type: 'error', error: string }
{ type: 'data', data: number[] }
{ type: 'disconnected' }
```

### Connection URL Parameters

Configuration via query string:
- `device` - Device name prefix to scan for
- `service` - BLE service UUID
- `write` - Write characteristic UUID
- `notify` - Notify characteristic UUID

Example: `ws://localhost:8080?device=CS108&service=9800&write=9900&notify=9901`

## Design Decisions

### Why One Connection?

Supporting multiple simultaneous connections would require:
- Connection multiplexing and routing
- State tracking per connection
- Complex cleanup coordination
- Race condition prevention

By limiting to one connection:
- State machine stays simple
- No routing logic needed
- Predictable behavior
- Rock-solid reliability

### Why 5-Second Recovery?

BLE on Linux (via BlueZ) needs time to:
- Clean up kernel resources
- Reset adapter state
- Clear device cache
- Prevent "Device or resource busy" errors

The 5-second delay ensures stable reconnections.

### Why No Reconnection Logic?

Reconnection belongs in the application layer because:
- Apps know their specific retry requirements
- Different use cases need different strategies
- Keeps bridge complexity minimal
- Easier to debug when it's explicit

## Security Considerations

### Current Limitations
- No authentication on WebSocket
- No encryption beyond WSS
- Trusts all incoming commands
- No rate limiting

### Recommended Deployment
1. Run on isolated network
2. Use firewall rules to restrict access
3. Enable HTTPS/WSS in production
4. Add authentication layer if needed

## Performance Characteristics

### Throughput
- WebSocket message overhead: ~100 bytes/message
- Noble.js overhead: ~50μs per operation
- Typical round-trip: 10-50ms (mostly BLE latency)
- Maximum practical throughput: ~100 messages/second

### Memory Usage
- Base Node.js: ~30MB
- With Noble.js loaded: ~50MB
- Per connection overhead: ~1MB
- Log buffer (10k entries): ~10MB

### CPU Usage
- Idle: <1%
- Active connection: 2-5%
- During scanning: 5-10%
- Stress test peaks: 15-20%

## Extension Points

While designed for simplicity, the architecture allows:

1. **Custom Bridge Implementations**: Implement the same WebSocket protocol
2. **Alternative Transports**: Replace WebSocket with TCP, IPC, etc.
3. **Mock Enhancements**: Add more Web Bluetooth API surface
4. **Protocol Extensions**: Add new message types for special features


## Future Considerations

If complexity is needed, it should be added as optional layers:

1. **Connection Multiplexing**: Separate proxy service
2. **Device Management**: External orchestration
3. **Monitoring**: OpenTelemetry integration
4. **Security**: Reverse proxy with auth

The core bridge should remain simple and reliable.