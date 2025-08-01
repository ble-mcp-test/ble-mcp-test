name: "Session Manager Fixes and Cache Busting Implementation v0.5.3 (Enhanced Bug Investigation)"
description: |
  Complete session management fixes with deep investigation of the session ID regeneration bug, implement cache busting, add version checking capabilities, and provide minimal end-to-end test for deployment validation.

## Goal
Fix the critical session ID bug where console logs show correct session reuse but WebSocket connects with a different session, complete cache busting features, and prepare v0.5.3 release.

## Why
- **Critical Bug**: Downstream reports session ID mismatch between console logs and actual WebSocket connection
- **Stale bundle issues**: Browser/CDN caching serves old code versions
- **Testing baseline needed**: Users need minimal test to validate setup
- **Version verification**: No programmatic way to check loaded bundle version

## What
1. **PRIORITY**: Investigate and fix session ID regeneration bug
2. Finalize cache busting with versioned bundles
3. Add runtime version checking capabilities
4. Provide minimal end-to-end test in deployment
5. Update to version 0.5.3

### Success Criteria
- [ ] Session ID bug fixed - console logs match actual WebSocket URL
- [ ] Comprehensive logging added to trace session ID flow
- [ ] Versioned bundle files created (web-ble-mock.bundle.v0.5.3.js)
- [ ] WebBleMock.version returns "0.5.3"
- [ ] Minimal test HTML included in npm package
- [ ] All tests pass with no session mismatches

## All Needed Context

### Session ID Bug Analysis
```yaml
# The Bug Report
- Console shows: "[MockBluetooth] Reusing stored session: 127.0.0.1-chrome-524F"
- Server receives: "New WebSocket connection for session: 127.0.0.1-chrome-9ZN4"
- Downstream concern: "appears to be at a lower level than local storage"
- Location: "Somewhere between url generation and actual connection to websocket"

# Session ID Flow (Current Implementation)
1. MockBluetooth constructor
   - If no sessionId in bleConfig, calls generateAutoSessionId()
   - Stores in this.autoSessionId

2. requestDevice() 
   - Creates effectiveConfig with sessionId || autoSessionId
   - Passes to MockBluetoothDevice constructor

3. MockBluetoothDevice constructor
   - Stores bleConfig including sessionId
   - Creates WebSocketTransport instance

4. connect() in MockBluetoothRemoteGATTServer
   - Maps bleConfig.sessionId to connectOptions.session (lines 185-186)
   - Logs: "[MockGATT] Using session ID for WebSocket: {sessionId}"
   - Calls transport.connect(connectOptions)

5. WebSocketTransport.connect()
   - Adds session to URL searchParams if provided
   - Creates WebSocket with url.toString()

# Potential Bug Locations
- Multiple injectWebBluetoothMock calls creating new MockBluetooth instances
- URL modification after construction but before WebSocket creation
- Race condition between localStorage read and WebSocket connection
- Session parameter not properly passed through layers
```

### Critical Code References
```yaml
# Session ID Generation and Persistence
- file: src/mock-bluetooth.ts
  lines: 376-412
  function: generateAutoSessionId()
  critical: Reads from localStorage, generates new if not found

- file: src/mock-bluetooth.ts  
  lines: 184-193
  function: connect() mapping sessionId
  critical: Maps sessionId to session, logs the mapping

- file: src/ws-transport.ts
  lines: 43-48
  function: connect() URL construction
  critical: Adds session param to URL, creates WebSocket

# Uncommitted Changes
- scripts/build-browser-bundle.js        # Cache busting implementation
- src/mock-browser-entry.ts             # Version export (hardcoded 0.5.2)
- src/mock-bluetooth.ts                 # getBundleVersion() function
- tests/e2e/cache-busting.spec.ts      # Cache busting tests
- tests/e2e/session-bug-repro.spec.ts   # Session bug reproduction
```

### Known Issues and Gotchas
```typescript
// CRITICAL BUG: Session ID might be regenerated between logging and connection
// Need to add logging at WebSocket URL construction point

// GOTCHA: injectWebBluetoothMock creates NEW MockBluetooth instance
// Each injection generates new autoSessionId if called without explicit session

// GOTCHA: localStorage blocked in about:blank context
// Tests must use HTTP context for session persistence

// IMPORTANT: Console logs may not reflect actual WebSocket URL
// Need to log the EXACT URL passed to new WebSocket()
```

## Implementation Blueprint

### Task Order for Bug Investigation and Fixes

```yaml
Task 1: Add comprehensive logging for session ID tracking
MODIFY src/ws-transport.ts:
  - BEFORE line 48: this.ws = new WebSocket(url.toString());
  - ADD: console.log(`[WebSocketTransport] Connecting to: ${url.toString()}`);
  - ADD: console.log(`[WebSocketTransport] Session parameter: ${options?.session || 'none'}`);
  - This will show EXACTLY what URL is used for WebSocket

Task 2: Add session ID validation in MockBluetooth
MODIFY src/mock-bluetooth.ts:
  - IN requestDevice() after effectiveConfig creation
  - ADD: console.log(`[MockBluetooth] requestDevice using session: ${effectiveConfig.sessionId}`);
  - IN MockBluetooth constructor after autoSessionId generation
  - ADD property to track if this is a re-injection

Task 3: Create comprehensive session tracking test
CREATE tests/integration/session-id-tracking.test.ts:
  - Test single injection flow
  - Test multiple injection flow
  - Capture ALL console logs
  - Compare localStorage session vs WebSocket URL session
  - Use MCP tools to verify server-side session

Task 4: Fix the session ID bug (based on findings)
POTENTIAL FIXES:
  - Option 1: Prevent multiple MockBluetooth instances
    - Store global reference to prevent re-creation
    - Check if navigator.bluetooth already exists
  
  - Option 2: Ensure WebSocketTransport uses correct session
    - Add validation that session in URL matches expected
    - Log warning if mismatch detected
  
  - Option 3: Make session ID immutable once set
    - Prevent regeneration on subsequent calls
    - Use singleton pattern for session management

Task 5: Update version to 0.5.3
MODIFY package.json:
  - FIND: "version": "0.5.2"
  - REPLACE: "version": "0.5.3"

Task 6: Update hardcoded version
MODIFY src/mock-browser-entry.ts:
  - FIND: version: '0.5.2'
  - REPLACE: version: '0.5.3'

Task 7: Create minimal E2E test with session validation
CREATE examples/minimal-e2e-test.html:
  - Test bundle loading and version
  - Test session persistence with validation
  - Capture WebSocket URL from logs
  - Compare logged session vs URL session
  - Clear pass/fail indication

Task 8: Update package.json to include test file
MODIFY package.json:
  - ADD to "files" array: "examples/minimal-e2e-test.html"

Task 9: Run comprehensive validation
  - Build and test with new logging
  - Verify session IDs match throughout flow
  - Test with downstream reproduction scenario
  - Use MCP tools to verify server-side behavior
```

### Debugging Implementation
```typescript
// Enhanced logging for session tracking
class WebSocketTransport {
  async connect(options?: { session?: string; /* ... */ }): Promise<void> {
    const url = new URL(this.serverUrl);
    // ... add parameters ...
    
    if (options?.session) {
      url.searchParams.set('session', options.session);
      this.sessionId = options.session;
      console.log(`[WebSocketTransport] Session added to URL: ${options.session}`);
    } else {
      console.warn(`[WebSocketTransport] No session provided in options`);
    }
    
    const finalUrl = url.toString();
    console.log(`[WebSocketTransport] Final WebSocket URL: ${finalUrl}`);
    
    this.ws = new WebSocket(finalUrl);
    // ...
  }
}

// Session validation in mock
class MockBluetooth {
  private static instances = new Map<string, MockBluetooth>();
  
  constructor(serverUrl?: string, bleConfig?: any) {
    // Check for existing instance
    const key = serverUrl || 'default';
    if (MockBluetooth.instances.has(key)) {
      console.warn(`[MockBluetooth] Reusing existing instance for ${key}`);
      return MockBluetooth.instances.get(key)!;
    }
    
    // ... rest of constructor ...
    MockBluetooth.instances.set(key, this);
  }
}
```

### Minimal E2E Test Structure
```html
<!DOCTYPE html>
<html>
<head>
    <title>BLE Mock E2E Test v0.5.3</title>
    <style>
        .pass { color: green; }
        .fail { color: red; }
        .log { font-family: monospace; font-size: 12px; }
    </style>
</head>
<body>
    <h1>Session ID Validation Test</h1>
    <div id="results"></div>
    <pre id="logs"></pre>
    
    <script src="../dist/web-ble-mock.bundle.js"></script>
    <script>
        const logs = [];
        const originalLog = console.log;
        
        // Capture all logs
        console.log = function(...args) {
            const message = args.join(' ');
            logs.push(message);
            document.getElementById('logs').textContent = logs.join('\n');
            originalLog.apply(console, args);
        };
        
        async function testSessionConsistency() {
            const results = [];
            
            // Test 1: Initial injection
            window.WebBleMock.clearStoredSession();
            window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
                service: '9800',
                write: '9900', 
                notify: '9901'
            });
            
            const sessionFromLogs = extractSessionFromLogs(logs, 'Generated new session:');
            
            // Test 2: Second injection (should reuse)
            logs.length = 0;
            window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080', {
                service: '9800',
                write: '9900',
                notify: '9901'
            });
            
            const reusedSession = extractSessionFromLogs(logs, 'Reusing stored session:');
            const wsUrlSession = extractSessionFromLogs(logs, 'Final WebSocket URL:');
            
            results.push({
                test: 'Session Consistency',
                pass: reusedSession && wsUrlSession && reusedSession === extractSessionFromUrl(wsUrlSession),
                detail: `Logged: ${reusedSession}, URL: ${wsUrlSession}`
            });
            
            displayResults(results);
        }
        
        function extractSessionFromLogs(logs, pattern) {
            const log = logs.find(l => l.includes(pattern));
            if (!log) return null;
            const match = log.match(/session[=:]?\s*([A-Z0-9.-]+)/i);
            return match ? match[1] : null;
        }
        
        function extractSessionFromUrl(url) {
            const match = url.match(/session=([^&]+)/);
            return match ? match[1] : null;
        }
        
        function displayResults(results) {
            const div = document.getElementById('results');
            div.innerHTML = results.map(r => 
                `<div class="${r.pass ? 'pass' : 'fail'}">
                    ${r.pass ? '✅' : '❌'} ${r.test}: ${r.detail}
                </div>`
            ).join('');
        }
        
        window.addEventListener('DOMContentLoaded', testSessionConsistency);
    </script>
</body>
</html>
```

## Validation Loop

### Level 1: Syntax & Build
```bash
# Update version first
sed -i 's/"version": "0.5.2"/"version": "0.5.3"/' package.json

# Fix lint/type errors
pnpm run lint
pnpm run typecheck

# Clean build
rm -rf dist/
pnpm run build

# Verify logging added
grep -n "Final WebSocket URL" dist/ws-transport.js
# Expected: Match found with line number
```

### Level 2: Session ID Bug Verification
```bash
# Run the new session tracking test
pnpm run test tests/integration/session-id-tracking.test.ts

# Run session bug reproduction with new logging
pnpm exec playwright test tests/e2e/session-bug-repro.spec.ts --reporter=list

# Check logs for session consistency
# Expected: Session in logs matches session in WebSocket URL
```

### Level 3: Integration Testing
```bash
# Start bridge server with MCP
pnpm run start

# In another terminal, run minimal E2E test
cd examples && python3 -m http.server 8000

# Open http://localhost:8000/minimal-e2e-test.html
# Expected: Session Consistency test passes

# Use MCP to verify server sees correct session
# Check that multiple connections use same session
```

### Level 4: Downstream Validation
```bash
# Create test scenario matching downstream
cat > test-downstream.js << 'EOF'
// First page load
window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
const device1 = await navigator.bluetooth.requestDevice({filters: [{namePrefix: 'CS108'}]});
await device1.gatt.connect();
console.log('First connection session:', device1.sessionId);
await device1.gatt.disconnect();

// Simulate page reload
window.WebBleMock.injectWebBluetoothMock('ws://localhost:8080');
const device2 = await navigator.bluetooth.requestDevice({filters: [{namePrefix: 'CS108'}]});
await device2.gatt.connect();
console.log('Second connection session:', device2.sessionId);
EOF

# Run and verify sessions match
```

## Final Validation Checklist
- [ ] Session ID bug fixed - logs match WebSocket URL
- [ ] WebSocketTransport logs final URL with session
- [ ] MockBluetooth prevents duplicate instances
- [ ] Version updated to 0.5.3 throughout
- [ ] Versioned bundle created
- [ ] Minimal E2E test validates session consistency
- [ ] MCP tools confirm server receives consistent session
- [ ] No lint/type errors
- [ ] All tests pass
- [ ] Downstream scenario validated

## Anti-Patterns to Avoid
- ❌ Don't assume console.log reflects actual behavior
- ❌ Don't create multiple MockBluetooth instances
- ❌ Don't skip WebSocket URL logging
- ❌ Don't ignore the "lower level" nature of the bug
- ❌ Don't test only in ideal conditions

---

**PRP Confidence Score: 9.5/10**

This enhanced PRP specifically targets the session ID bug with comprehensive logging and validation. The bug appears to be between URL construction and WebSocket creation, and our logging will pinpoint exactly where the session changes.