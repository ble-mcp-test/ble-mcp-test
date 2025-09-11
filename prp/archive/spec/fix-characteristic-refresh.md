## FEATURE:
Remove characteristic refresh when reusing BLE sessions to prevent subscription accumulation and zombie connections. When a WebSocket reconnects to an existing session with an active transport, trust the existing characteristic references instead of re-discovering them. Add minimal metrics to track subscription health and detect potential issues.

**Success Criteria:**
- Session reuse does not call `refreshCharacteristics()`
- Existing characteristic references continue to work across reconnections
- No accumulation of Noble characteristic objects or subscriptions
- Metrics log potential issues for monitoring
- E2E tests pass consistently without zombie connections

## EXAMPLES:
Current problematic pattern in `src/bridge-server.ts` lines 125-137:
```typescript
if (status.hasTransport) {
  // Currently calls refreshCharacteristics() which creates duplicates
  await session.refreshCharacteristics();  // REMOVE THIS
}
```

Desired pattern:
```typescript
if (status.hasTransport) {
  // Trust existing transport and characteristics
  console.log(`[Bridge] Reusing existing transport without refresh`);
  // Add metric tracking
  MetricsTracker.getInstance().recordSessionReuseWithoutRefresh(sessionId);
}
```

Similar trust pattern in `src/session-manager.ts` line 99 where we already reuse sessions.

## DOCUMENTATION:
- Internal: Current implementation at `src/bridge-server.ts` lines 125-143
- Internal: `refreshCharacteristics()` method at `src/noble-transport.ts` lines 408-463
- Internal: Metrics tracking pattern at `src/connection-metrics.ts`
- Noble characteristic lifecycle: Each `discoverCharacteristicsAsync()` creates new objects
- Known issue: Multiple characteristic objects for same BLE characteristic causes subscription accumulation

## OTHER CONSIDERATIONS:
- **Risk Acceptance**: This assumes stable BLE connections per user requirements
- **Inactivity Timeout**: Currently set to 600 seconds (10 minutes) from zombie war refactoring
  - Consider keeping at 600s for now to allow long-running operations
  - Can dial back to 60-120s if we see characteristic staleness issues
- **Metrics**: Track reuse count to detect if characteristics become stale
- **Safeguard**: Log warning if session reused more than 10 times
- **Fallback**: On any write error, force session cleanup for next connection
- **Testing**: Must verify E2E tests pass without characteristic refresh
- **Rollback Plan**: Can re-enable refresh if stability issues arise
- **Zombie Prevention**: This directly addresses the root cause of zombie accumulation