# Separation of Concerns - Architecture Principle

## Core Principle
**web-ble-bridge is concerned with transport and connection handling ONLY**

## Layer Responsibilities

### 1. Transport Layer (web-ble-bridge)
**Concerns**:
- WebSocket ↔ BLE bridging
- Connection management
- Raw packet transmission (TX/RX)
- Logging and debugging infrastructure
- Sequence numbering and timestamps

**NOT Concerns**:
- Protocol interpretation
- Device-specific commands
- Business logic
- Test scenarios

### 2. Test/Application Layer (consumers)
**Concerns**:
- Device-specific protocol knowledge
- Command interpretation
- Test scenarios and validation
- Business logic

**Examples**:
```typescript
// In test code (NOT in bridge)
import { CS108Commands } from '@trakrf/cs108-protocol';

// Test layer interprets the protocol
const batteryCmd = CS108Commands.GET_BATTERY_VOLTAGE;
await bridge.send(batteryCmd);

const response = await bridge.receive();
const voltage = CS108Commands.parseBatteryResponse(response);
```

### 3. Optional Protocol Libraries (separate packages)
**Purpose**: Reusable protocol knowledge
**Examples**:
- `@trakrf/cs108-protocol`
- `@trakrf/nrf52-protocol`
- Community packages

**Usage**:
```typescript
// Protocol library provides interpretation
export const CS108Commands = {
  GET_BATTERY_VOLTAGE: 'A7B302D98237000A000',
  
  parseBatteryResponse(hex: string): number {
    // Device-specific parsing logic
  }
};
```

## Benefits

1. **Clean Architecture**: Each layer has clear responsibilities
2. **Reusability**: Bridge works with ANY BLE device
3. **Testability**: Protocol logic can be tested independently
4. **Flexibility**: New devices don't require bridge changes
5. **Maintainability**: Changes to protocol don't affect transport

## Implementation Guidelines

### DO:
- Keep bridge focused on transport
- Put protocol knowledge in test code
- Create separate protocol libraries for reuse
- Use raw hex at transport level

### DON'T:
- Add device-specific logic to bridge
- Interpret packets in transport layer
- Build protocol decoders into MCP tools
- Mix concerns between layers

## Example Architecture

```
┌─────────────────────┐
│   Test/App Layer    │  ← Protocol interpretation
├─────────────────────┤
│ Protocol Libraries  │  ← Optional reusable protocol knowledge
├─────────────────────┤
│  web-ble-bridge     │  ← Transport only (TX/RX raw hex)
├─────────────────────┤
│   WebSocket/BLE     │  ← Physical transport
└─────────────────────┘
```

This separation ensures web-ble-bridge remains a general-purpose tool while allowing sophisticated protocol handling at the appropriate layer.