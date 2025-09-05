# E2E Test Reorganization Plan

## Current State (7 files, ~50 tests)
1. core-session-reuse.spec.ts - Session reuse across tests
2. disconnect-reconnect-same-session.spec.ts - Session survives disconnect  
3. zombie-reproduction.spec.ts - No zombie connections after 3 cycles
4. session-rejection.spec.ts - Different session gets rejected
5. mock-quality-assurance.spec.ts - Mock functionality (17 tests)
6. real-device-session.spec.ts - Real device connection
7. websocket-url-verification.spec.ts - URL parameter verification

## Proposed Structure (5 files, better organized)

### 1. **mock-functionality.spec.ts** (was mock-quality-assurance)
Comprehensive mock testing - keep all 17 tests plus:
- Add WebSocket URL verification test (from websocket-url-verification.spec.ts)
- Add version compatibility check
- Add health endpoint test

### 2. **session-management.spec.ts** (consolidated)
Core session features:
- Session reuse across tests (from core-session-reuse)
- Service-based filtering (from real-device-session)  
- Session rejection for different IDs (from session-rejection)
- Hostname-based session isolation (NEW)

### 3. **connection-reliability.spec.ts** (critical for client)
Connection stability:
- Disconnect/reconnect same session (from disconnect-reconnect)
- Zombie prevention - 3 cycles (from zombie-reproduction)
- Rapid connect/disconnect stress test (NEW)
- Bridge recovery after disconnect (NEW)

### 4. **standalone-injection.spec.ts** (CI/CD pattern)
Tests without dev server (critical for CI):
- Test injects mock directly
- Session reuse across test files
- Clean state between test runs
- No dev server dependency

### 5. **dev-server-integration.spec.ts** (Development pattern) 
Tests with pre-injected mock:
- Mock already injected by dev server
- Tests verify mock is present
- Session persists across navigation
- Multiple tabs share same session

### 6. **bridge-operations.spec.ts** (NEW - operational tests)
Bridge server features:
- Health endpoint responds correctly
- Metrics endpoint provides data
- Multiple WebSocket clients supported
- Graceful shutdown handling

## Tests to Remove/Consolidate

### Remove:
- websocket-url-verification.spec.ts (move single test to mock-functionality)
- real-device-session.spec.ts (merge service filtering into session-management)

### Keep As-Is:
- zombie-reproduction.spec.ts (critical, well-focused)
- disconnect-reconnect-same-session.spec.ts (tests specific bug)

## New Tests to Add

### High Priority:
1. Dev server pattern (inject once, use many)
2. Hostname isolation (multi-developer scenario)
3. Health endpoint verification
4. Version compatibility check

### Medium Priority:
1. Multiple browser tabs
2. Bridge restart recovery
3. Rapid connection cycling
4. Long-running connection stability

### Low Priority:
1. Performance benchmarks
2. Memory leak detection
3. Concurrent operations
4. Error recovery scenarios

## Benefits of Reorganization

1. **Better alignment with real usage** - Dev server pattern is what client actually uses
2. **Clearer test categories** - Mock, Session, Connection, DevServer, Bridge
3. **Less duplication** - Consolidated overlapping tests
4. **Better coverage** - Added missing critical tests
5. **Easier maintenance** - Logical grouping of related tests

## Implementation Order

1. First: Add dev-server-pattern.spec.ts (most important gap)
2. Second: Consolidate session tests into session-management.spec.ts
3. Third: Add bridge-operations.spec.ts for operational health
4. Fourth: Clean up and remove redundant files
5. Fifth: Update test-config.ts helpers for new patterns