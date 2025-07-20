# WebSocket-to-BLE Bridge

A minimal, device-agnostic WebSocket-to-BLE bridge. Originally extracted from noble-cs108-cruft but now supports any BLE device by passing UUIDs as parameters.

## Features

- WebSocket server that bridges to BLE devices
- Web Bluetooth API mock for browser testing
- Simple, direct communication (no abstractions)
- < 500 lines of code total

## Installation

```bash
pnpm install
pnpm build
```

## Usage

### Start the bridge server (macOS with BLE hardware)

```bash
./scripts/start-ws-bridge-macos.sh
```

Or manually:

```bash
pnpm start
```

### Environment Variables

- `WS_PORT` - WebSocket port (default: 8080)
- `WS_HOST` - WebSocket host (default: 0.0.0.0)
- `CS108_DEVICE_NAME` - Specific device name or empty for first CS108 found

### Browser Usage

```javascript
import { injectWebBluetoothMock } from '@trakrf/web-ble-bridge';

// Inject the mock (replaces navigator.bluetooth)
injectWebBluetoothMock('ws://localhost:8080');

// Use Web Bluetooth API as normal
const device = await navigator.bluetooth.requestDevice({
  filters: [{ namePrefix: 'CS108' }]
});
const server = await device.gatt.connect();
```

## Protocol

WebSocket messages use simple JSON format:

### Client → Server
```json
{ "type": "data", "data": [0xA7, 0xB3, ...] }
```

### Server → Client
```json
{ "type": "connected", "device": "CS108Reader000000" }
{ "type": "data", "data": [0xB3, 0xA7, ...] }
{ "type": "disconnected" }
{ "type": "error", "error": "Device not found" }
```

## Architecture

- `bridge-server.ts` - WebSocket server
- `noble-transport.ts` - Noble BLE wrapper
- `ws-transport.ts` - WebSocket client
- `mock-bluetooth.ts` - Web Bluetooth API mock
- Total: 423 lines of code