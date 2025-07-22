# Contributing to web-ble-bridge

We love contributions! This guide will help you get started quickly.

## What is this project?

web-ble-bridge is a minimal WebSocket-to-BLE bridge that lets you test Web Bluetooth code in browsers without BLE support. It's intentionally simple - under 600 lines of code that directly forward WebSocket messages to BLE devices.

## Before You Start

### Required Tools
- **Node.js 24.x** (exactly - not 22.x or 26.x, due to Noble.js BLE requirements)
- **pnpm** - Install with: `npm install -g pnpm`
- **Git** - For version control
- **BLE hardware** - Only needed if you want to test with real devices

### Quick Setup
```bash
# 1. Fork this repo on GitHub

# 2. Clone your fork
git clone https://github.com/YOUR_USERNAME/web-ble-bridge.git
cd web-ble-bridge

# 3. Install dependencies
pnpm install

# 4. Build the project
pnpm build

# 5. Run tests (unit tests work without BLE hardware)
pnpm test:run
```

## Making Changes

### 1. Create a Branch
```bash
# Branch naming:
# - feature/add-xyz    (new features)
# - fix/broken-xyz     (bug fixes)
# - docs/update-xyz    (documentation)

git checkout -b feature/add-reconnect
```

### 2. Write Your Code

**Project Philosophy:**
- **Simple** - No abstractions, managers, or complex patterns
- **Small** - Keep files under 150 lines
- **Direct** - Code should do exactly what it says
- **Async** - Use async/await (no callbacks except event handlers)

**Good Example:**
```typescript
// Clear, direct, simple
export async function sendData(ws: WebSocket, data: Uint8Array): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'data', data: Array.from(data) }));
  }
}
```

**Bad Example:**
```typescript
// Over-engineered, abstract, complex
export class WebSocketDataTransmissionManager {
  private queue: DataPacket[] = [];
  private strategy: TransmissionStrategy;
  
  public async transmitWithRetry(data: Uint8Array): Promise<TransmissionResult> {
    // 50 more lines of abstraction...
  }
}
```

### 3. Test Your Changes
```bash
# Run all tests
pnpm test:run

# Check types
pnpm typecheck

# Check code style
pnpm lint
```

### 4. Commit Your Work
```bash
# Use conventional commits
git commit -m "feat: add device reconnection support"
git commit -m "fix: handle empty data packets"
git commit -m "docs: clarify WebSocket protocol"
```

## Testing Guide

### Unit Tests (No BLE Required)
```typescript
// tests/unit/my-feature.test.ts
import { describe, it, expect } from 'vitest';

describe('my feature', () => {
  it('does something specific', () => {
    const result = myFunction('input');
    expect(result).toBe('expected output');
  });
});
```

### Integration Tests (BLE Required)
```bash
# Set up test environment
export WS_URL=ws://localhost:8080
export BLE_DEVICE_PREFIX=CS108  # Or your device

# Run integration tests
pnpm test tests/integration
```

## Submitting Your Work

1. **Push to your fork:**
   ```bash
   git push origin feature/add-reconnect
   ```

2. **Open a Pull Request:**
   - Go to https://github.com/trakrf/web-ble-bridge
   - Click "New Pull Request"
   - Select your branch
   - Describe what you changed and why

3. **PR Checklist:**
   - [ ] Tests pass (`pnpm test:run`)
   - [ ] Types check (`pnpm typecheck`)
   - [ ] Code follows project style
   - [ ] Commit messages use conventional format
   - [ ] Documentation updated if needed

## Common Tasks

### Adding a New Web Bluetooth API Method
1. Add the method to `mock-bluetooth.ts`
2. Update the TypeScript types if needed
3. Add a test showing it works
4. Update `docs/API.md` with the new method

### Fixing a Bug
1. Write a test that reproduces the bug
2. Fix the code until the test passes
3. Ensure no other tests break

### Improving Documentation
1. Edit the relevant `.md` file
2. Use clear, simple language
3. Add code examples where helpful

## Getting Help

- **Questions?** Open an issue with the "question" label
- **Found a bug?** Open an issue with steps to reproduce
- **Have an idea?** Open an issue to discuss before coding

## Code of Conduct

Be kind, be helpful, keep it simple.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
