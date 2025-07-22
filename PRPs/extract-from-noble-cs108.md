# PRP: Extract Minimal WebSocket-to-BLE Bridge from noble-cs108-cruft

## Overview
Complete rewrite extracting only working code from the overcomplicated noble-cs108-cruft implementation. Target is <500 lines total with zero abstractions, focusing on three proven source files.

## Critical Context

### 1. Noble.js Async Patterns (MANDATORY)
**CRITICAL**: The old codebase correctly uses async/await patterns. You MUST preserve this:
- Use ONLY `@stoprocent/noble` (v0.1.14) - NOT @abandonware/noble
- Use ONLY async/await patterns
- ALWAYS await Noble operations
- Event handlers are the ONLY place callbacks are acceptable

NPM Documentation: https://www.npmjs.com/package/@stoprocent/noble

**Correct Pattern from noble-transport.ts:54:**
```javascript
await peripheral.connectAsync();
await peripheral.discoverSomeServicesAndCharacteristicsAsync([SERVICE_UUID], [RX_UUID, TX_UUID]);
await characteristic.writeAsync(Buffer.from(data), false);
await characteristic.subscribeAsync();
```

### 2. Source Files to Extract (../noble-cs108-cruft/)

#### a) `packages/web-ble-mock/src/mock-bluetooth.ts` (176 lines → ~100 lines)
**Copy 90% as-is, remove only:**
- Lines 143-145, 169-175: Console logging (save ~10 lines)
- Lines 138-141: Environment variable handling (save ~4 lines)
- Stub removeEventListener implementations (save ~6 lines)
- Total removal: ~20 lines

**Critical to keep:**
- All mock classes structure
- WebSocketTransport integration pattern
- Device name bypass logic (lines 139-144)
- Notification event handling

#### b) `packages/ws-bridge/src/transport/noble-transport.ts` (135 lines → ~100 lines)
**Extract core BLE only:**
- Lines 1-6: Keep imports and UUIDs
- Lines 14-85: Keep connect() but simplify device matching
- Lines 87-95: Keep sendData()
- Lines 97-108: Keep disconnect()
- Lines 110-119: Keep event handlers

**Remove:**
- EventEmitter inheritance (use callbacks)
- Lines 130-135: Nuclear cleanup
- All console.log statements
- Complex ANY device logic (simplify to prefix matching)

#### c) `packages/web-ble-mock/src/websocket-transport.ts` (309 lines → ~100 lines)
**Strip heavily - remove 209+ lines:**
- Keep lines 1-10: WSMessage interface
- Keep basic WebSocket connection (simplify lines 41-60)
- Keep message handling (simplify lines 215-250)
- REMOVE ALL: reconnection (lines 287-308), message queue (lines 27, 283-285), state tracking beyond connected

### 3. Test Patterns to Reference

#### Integration Test Example (test-simplified-connection.mjs):
```javascript
const ws = new WebSocket('ws://localhost:8080?deviceId=ANY');
await new Promise((resolve, reject) => {
  ws.once('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'connected') resolve();
    else if (msg.type === 'error') reject(new Error(msg.error));
  });
});
// Send CS108 test command
ws.send(JSON.stringify({
  seq: 1,
  type: 'data',
  data: [0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x02]
}));
```

#### E2E Test Pattern (battery-voltage.test.ts):
```javascript
await page.evaluate(async () => {
  const { injectWebBluetoothMock } = await import('/@trakrf/web-ble-bridge');
  injectWebBluetoothMock('ws://localhost:8080');
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'CS108' }]
  });
  const server = await device.gatt.connect();
  // Battery voltage should be 3000-4500 mV
});
```

## Implementation Blueprint

### 1. Package Setup (package.json)
```json
{
  "name": "@trakrf/web-ble-bridge",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest",
    "lint": "eslint src --ext .ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@stoprocent/noble": "0.1.14",
    "ws": "^8.16.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "@types/ws": "^8.5.10",
    "@playwright/test": "^1.40.0",
    "typescript": "^5.3.3",
    "vitest": "^1.2.0",
    "eslint": "^8.56.0"
  }
}
```

### 2. TypeScript Config (tsconfig.json)
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 3. File Implementations

#### src/index.ts (~20 lines)
```typescript
export { BridgeServer } from './bridge-server.js';
export { injectWebBluetoothMock } from './mock-bluetooth.js';
export { WebSocketTransport } from './ws-transport.js';
export type { WSMessage } from './ws-transport.js';
```

#### src/bridge-server.ts (~100 lines)
```typescript
import { WebSocketServer } from 'ws';
import { NobleTransport } from './noble-transport.js';

export class BridgeServer {
  private wss: WebSocketServer | null = null;

  start(port = 8080) {
    this.wss = new WebSocketServer({ port });
    
    this.wss.on('connection', async (ws, req) => {
      const url = new URL(req.url!, `http://localhost`);
      const devicePrefix = url.searchParams.get('device') || 'CS108';
      
      const transport = new NobleTransport();
      
      try {
        // Connect to BLE device
        await transport.connect(devicePrefix, {
          onData: (data) => {
            ws.send(JSON.stringify({ type: 'data', data: Array.from(data) }));
          },
          onDisconnected: () => {
            ws.send(JSON.stringify({ type: 'disconnected' }));
            ws.close();
          }
        });
        
        // Send connected message
        ws.send(JSON.stringify({ 
          type: 'connected', 
          device: transport.getDeviceName() 
        }));
        
        // Handle incoming messages
        ws.on('message', async (message) => {
          try {
            const msg = JSON.parse(message.toString());
            if (msg.type === 'data' && msg.data) {
              await transport.sendData(new Uint8Array(msg.data));
            }
          } catch (error) {
            // Ignore malformed messages
          }
        });
        
        // Clean disconnect on WebSocket close
        ws.on('close', () => {
          transport.disconnect();
        });
        
      } catch (error) {
        ws.send(JSON.stringify({ 
          type: 'error', 
          error: error.message 
        }));
        ws.close();
      }
    });
  }
  
  stop() {
    this.wss?.close();
  }
}
```

#### src/noble-transport.ts (~100 lines)
Simplified from ../noble-cs108-cruft/packages/ws-bridge/src/transport/noble-transport.ts:
```typescript
import noble from '@stoprocent/noble';

const SERVICE_UUID = '00001800-0000-1000-8000-00805f9b34fb';
const RX_UUID = '00002a00-0000-1000-8000-00805f9b34fb';
const TX_UUID = '00002a01-0000-1000-8000-00805f9b34fb';

interface Callbacks {
  onData: (data: Uint8Array) => void;
  onDisconnected: () => void;
}

export class NobleTransport {
  private peripheral: any = null;
  private rxChar: any = null;
  private deviceName = '';
  
  async connect(devicePrefix: string, callbacks: Callbacks): Promise<void> {
    // Start scanning
    await noble.startScanningAsync([], true);
    
    // Find device
    const peripheral = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        noble.stopScanningAsync();
        reject(new Error(`No device found with prefix: ${devicePrefix}`));
      }, 10000);
      
      noble.on('discover', (p) => {
        const name = p.advertisement.localName || '';
        if (name.startsWith(devicePrefix)) {
          clearTimeout(timeout);
          noble.stopScanningAsync();
          resolve(p);
        }
      });
    });
    
    this.peripheral = peripheral;
    this.deviceName = peripheral.advertisement.localName || 'Unknown';
    
    // Connect
    await peripheral.connectAsync();
    
    // Discover services
    const result = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [SERVICE_UUID], 
      [RX_UUID, TX_UUID]
    );
    
    const rxChar = result.characteristics.find(c => c.uuid === RX_UUID);
    const txChar = result.characteristics.find(c => c.uuid === TX_UUID);
    
    if (!rxChar || !txChar) {
      throw new Error('Required characteristics not found');
    }
    
    this.rxChar = rxChar;
    
    // Subscribe to notifications
    txChar.on('data', (data) => {
      callbacks.onData(new Uint8Array(data));
    });
    await txChar.subscribeAsync();
    
    // Handle disconnection
    peripheral.once('disconnect', () => {
      callbacks.onDisconnected();
    });
  }
  
  async sendData(data: Uint8Array): Promise<void> {
    if (!this.rxChar) throw new Error('Not connected');
    await this.rxChar.writeAsync(Buffer.from(data), false);
  }
  
  async disconnect(): Promise<void> {
    if (this.peripheral?.state === 'connected') {
      await this.peripheral.disconnectAsync();
    }
    this.peripheral = null;
    this.rxChar = null;
  }
  
  getDeviceName(): string {
    return this.deviceName;
  }
}
```

#### src/mock-bluetooth.ts (~100 lines)
Copy from ../noble-cs108-cruft/packages/web-ble-mock/src/mock-bluetooth.ts with minimal changes:
- Remove lines 143-145, 169-175 (logging)
- Remove lines 138-141 (env vars)
- Keep all class structures intact

#### src/ws-transport.ts (~100 lines)
Heavily simplified from ../noble-cs108-cruft/packages/web-ble-mock/src/websocket-transport.ts:
```typescript
export interface WSMessage {
  type: 'data' | 'connected' | 'disconnected' | 'error';
  seq?: number;
  data?: number[];
  device?: string;
  error?: string;
}

export class WebSocketTransport {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  
  constructor(serverUrl = 'ws://localhost:8080') {
    this.serverUrl = serverUrl;
  }
  
  async connect(deviceId?: string): Promise<void> {
    const url = new URL(this.serverUrl);
    if (deviceId) url.searchParams.set('device', deviceId);
    
    this.ws = new WebSocket(url.toString());
    
    return new Promise((resolve, reject) => {
      this.ws!.onopen = () => {
        // Wait for connected message
      };
      
      this.ws!.onmessage = (event) => {
        const msg: WSMessage = JSON.parse(event.data);
        if (msg.type === 'connected') {
          resolve();
        } else if (msg.type === 'error') {
          reject(new Error(msg.error));
        }
      };
      
      this.ws!.onerror = () => reject(new Error('WebSocket error'));
      this.ws!.onclose = () => this.ws = null;
    });
  }
  
  send(data: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }
    this.ws.send(JSON.stringify({ 
      type: 'data', 
      data: Array.from(data) 
    }));
  }
  
  onMessage(callback: (msg: WSMessage) => void): void {
    if (this.ws) {
      this.ws.onmessage = (event) => {
        callback(JSON.parse(event.data));
      };
    }
  }
  
  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
  
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
```

### 4. Integration Test (tests/integration/connection.test.ts)
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BridgeServer } from '../src/index.js';
import WebSocket from 'ws';

describe('Bridge Connection', () => {
  let server: BridgeServer;
  
  beforeAll(() => {
    server = new BridgeServer();
    server.start(8080);
  });
  
  afterAll(() => {
    server.stop();
  });
  
  it('connects to CS108 device', async () => {
    const ws = new WebSocket('ws://localhost:8080?device=CS108');
    
    const connected = await new Promise((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') {
          resolve(true);
        }
      });
    });
    
    expect(connected).toBe(true);
    ws.close();
  });
  
  it('sends and receives data', async () => {
    const ws = new WebSocket('ws://localhost:8080?device=CS108');
    
    // Wait for connection
    await new Promise((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connected') resolve(true);
      });
    });
    
    // Send test command
    ws.send(JSON.stringify({
      type: 'data',
      data: [0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x02]
    }));
    
    // Should receive response
    const response = await new Promise((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'data') resolve(msg);
      });
    });
    
    expect(response).toHaveProperty('data');
    ws.close();
  });
});
```

### 5. E2E Test (tests/e2e/bridge.spec.ts)
```typescript
import { test, expect } from '@playwright/test';

test('browser can connect through bridge', async ({ page }) => {
  // Start bridge server
  const bridge = new BridgeServer();
  bridge.start(8080);
  
  // Create test page
  await page.setContent(`
    <html>
      <body>
        <div id="status">Disconnected</div>
        <script type="module">
          import { injectWebBluetoothMock, WebSocketTransport } from '/src/index.js';
          
          window.connect = async () => {
            injectWebBluetoothMock('ws://localhost:8080');
            
            const device = await navigator.bluetooth.requestDevice({
              filters: [{ namePrefix: 'CS108' }]
            });
            
            await device.gatt.connect();
            document.getElementById('status').textContent = 'Connected';
            return device.name;
          };
        </script>
      </body>
    </html>
  `);
  
  // Execute connection
  const deviceName = await page.evaluate(() => window.connect());
  
  // Verify
  expect(deviceName).toContain('CS108');
  const status = await page.textContent('#status');
  expect(status).toBe('Connected');
  
  bridge.stop();
});
```

## Validation Gates

### 1. Dependency Installation
```bash
pnpm install
```

### 2. TypeScript Compilation
```bash
pnpm tsc --noEmit
# Must compile without errors
```

### 3. Linting
```bash
pnpm eslint src --ext .ts
# Should pass with minimal/no warnings
```

### 4. Integration Tests
```bash
pnpm vitest run tests/integration
# All tests must pass
```

### 5. Line Count Verification
```bash
find src -name "*.ts" -exec wc -l {} + | tail -1
# Total must be < 500 lines
```

### 6. E2E Test (with real device)
```bash
pnpm playwright test
# Should connect to real CS108 if available
```

## Implementation Tasks (in order)

1. **Setup Project** (~30 min)
   - Create package.json with dependencies
   - Create tsconfig.json
   - Install dependencies with pnpm
   - Create src/ and tests/ directories

2. **Extract mock-bluetooth.ts** (~30 min)
   - Copy from noble-cs108-cruft
   - Remove logging (lines 143-145, 169-175)
   - Remove environment variables (lines 138-141)
   - Verify ~100 lines

3. **Extract noble-transport.ts** (~45 min)
   - Copy core structure from noble-cs108-cruft
   - Replace EventEmitter with callbacks
   - Simplify device matching to prefix only
   - Remove nuclear cleanup and logging
   - Ensure all Noble operations use async/await

4. **Simplify ws-transport.ts** (~45 min)
   - Start fresh with WSMessage interface
   - Basic WebSocket connection only
   - No reconnection or queuing
   - Simple message handling

5. **Create bridge-server.ts** (~30 min)
   - WebSocketServer setup
   - One connection = one BLE device
   - Forward messages bidirectionally
   - Clean disconnect handling

6. **Create index.ts** (~10 min)
   - Export all public APIs
   - Verify clean module structure

7. **Write Integration Tests** (~30 min)
   - Basic connection test
   - Data send/receive test
   - Error handling test

8. **Write E2E Test** (~30 min)
   - Playwright setup
   - Browser connection test
   - Verify mock injection works

9. **Final Validation** (~20 min)
   - Run all validation gates
   - Verify < 500 LOC
   - Fix any issues

## Common Pitfalls to Avoid

1. **DO NOT** mix callbacks with promises in Noble.js
2. **DO NOT** add any reconnection logic to ws-transport
3. **DO NOT** create abstractions (no coordinators, registries, layers)
4. **DO NOT** track state beyond connected/disconnected
5. **DO NOT** implement battery keepalive or metrics
6. **DO NOT** add manual connect/disconnect commands
7. **DO NOT** use @abandonware/noble - must use @stoprocent/noble
8. **DO NOT** forget to await Noble operations

## Reference Documentation

- Noble.js async API: https://www.npmjs.com/package/@stoprocent/noble
- WebSocket API: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
- Web Bluetooth API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API
- ws package: https://github.com/websockets/ws

## Success Criteria

- [ ] Works with existing trakrf-handheld Playwright tests
- [ ] Total implementation < 500 LOC
- [ ] Each file < 150 LOC  
- [ ] Zero race conditions (proper async/await)
- [ ] No reconnection logic
- [ ] No state beyond connected/disconnected
- [ ] All Noble operations use async/await pattern

---

**Confidence Score: 9/10**

This PRP provides:
- Exact line numbers and files to extract from
- Complete code samples showing the simplified approach
- All dependencies and configuration
- Executable validation gates
- Clear task ordering
- Common pitfalls from the previous implementation

The only uncertainty is around actual BLE device availability during testing, but the approach handles this with appropriate error messages.