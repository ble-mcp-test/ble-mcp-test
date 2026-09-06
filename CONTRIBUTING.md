# Contributing to ble-mcp-test

We love contributions! This guide will help you get started quickly.

## What is this project?

ble-mcp-test mocks the `navigator.bluetooth` Web API so browser E2E tests can drive **real BLE hardware** from headless environments — CI, VMs, containers.

Commands flow browser → mock → WebSocket → Python bridge → ESPHome proxy over TCP → device, and back. The hardware is real; only the Web Bluetooth API is mocked. If no device is reachable, connections fail — that is correct behaviour, not a bug in the mock.

Any GATT device works, configured by UUID env vars. CS108 UHF RFID is the reference device, not a requirement.

## Before You Start

### Required Tools
- **Node.js 24.x** — matches the pin in `.nvmrc` and `engines`. No dependency requires it; it matches platform's runtime, which is the reason to pin.
- **pnpm** - Install with: `npm install -g pnpm`
- **Git** - For version control
- **BLE hardware** - Only needed if you want to test with real devices

### Quick Setup
```bash
# 1. Fork this repo on GitHub

# 2. Clone your fork
git clone https://github.com/YOUR_USERNAME/ble-mcp-test.git
cd ble-mcp-test

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
# Branch naming: <type>/<slug>
# - feat/     fix/      docs/
# - chore/    refactor/ test/

git checkout -b feat/add-reconnect
```

### 2. Write Your Code

**Project Philosophy:**
- **Simple** - No abstractions, managers, or complex patterns
- **Small** - Aim for under 300 lines a file. 150 is the right size for a helper, a page
  object or a simple adapter, but it is a preference for small things, not a ceiling on
  everything. Past 500, stop and justify the file rather than adding to it — a handful of
  modules here are genuinely over, and they earned it one deliberate decision at a time
- **Direct** - Code should do exactly what it says
- **Async** - Use async/await (no callbacks except event handlers)

`AGENTS.md` carries the same rules in the terser form this repo's agents read.

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
# The whole gate: lint + typecheck + both test suites
just validate

# Or the pieces individually
pnpm test:run
pnpm typecheck
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

### Hardware Tests (BLE Required)
```bash
# Set up test environment
export WS_URL=ws://localhost:25153
export BLE_DEVICE_PREFIX=CS108  # Or your device

# Playwright, against a live device through a running bridge
pnpm test:e2e
```

## Submitting Your Work

1. **Push to your fork:**
   ```bash
   git push origin feat/add-reconnect
   ```

2. **Open a Pull Request:**
   - Go to https://github.com/ble-mcp-test/ble-mcp-test
   - Click "New Pull Request"
   - Select your branch
   - Describe what you changed and why

3. **How it gets merged:** with a merge commit — `gh pr merge --merge`. Never squash, never rebase; the commit history is preserved deliberately.

4. **PR Checklist:**
   - [ ] Tests pass (`pnpm test:run`)
   - [ ] Types check (`pnpm typecheck`)
   - [ ] Code follows project style
   - [ ] Commit messages use conventional format
   - [ ] Documentation updated if needed

## Publishing a release

`prepublishOnly` is `clean && build && pretest && playwright test` — the **full hardware e2e suite**, about 1.7 minutes against a live reader. npm 2FA is TOTP on a 30-second window, and npm checks the code at the *end* of the upload. So a single `pnpm publish --otp=X` needs a code that was issued ~100 seconds earlier, which is structurally unlikely rather than unlucky: it cost two failed publishes of 0.16.1 in one afternoon, each of which ran the whole hardware suite before failing with `npm error code EOTP`.

Two commands, in this order:

```bash
# 1. The gate. Runs prepublishOnly in full and uploads nothing. Takes the reader ~1.7 min.
pnpm publish --dry-run --no-git-checks

# 2. Publish immediately, with a FRESH OTP. Skips the gate step 1 already ran.
pnpm publish --ignore-scripts --no-git-checks --otp=<fresh code>
```

The OTP is now needed at the start of a sub-second operation instead of 100 seconds before the end of a long one.

Three things worth knowing before you run it:

- **`--dry-run` really does run the gate.** It is not a metadata-only preview — 23/23 e2e passed against real hardware under it on 2026-08-31.
- **It exits 1 when the version is already published**, with `You cannot publish over the previously published versions`. The gate still ran and still passed; the non-zero exit is the upload refusal. Do not write "the dry run must exit 0" into a check — re-verifying a version that is already out is the most likely reason to reach for one.
- **`--ignore-scripts` is safe here only because step 1 ran the identical gate seconds earlier.** On its own it skips the hardware suite entirely and publishes unverified code. The two commands are one procedure, not two options.

**Step 1 takes the CS108 for ~1.7 minutes; step 2 touches no hardware.** Anyone else using the reader has to be told before step 1 and again when it finishes — *including before a retry*, which is the specific omission that caused a collision on 2026-08-31. There is no lock enforcing this yet; TRA-1241 is designing one.

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
