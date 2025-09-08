# Specification: Migrate Console Statements to Logger System

## FEATURE:
Replace all 129 `console.log`, `console.warn`, and `console.error` statements in source code with the existing `Logger` class to provide consistent, configurable logging throughout the application.

The project already has a proper `Logger` class in `src/logger.ts` with log levels, but most code still uses raw console statements. This creates inconsistent logging behavior and makes it difficult to control log output in different environments.

## EXAMPLES:
Current problematic patterns:
```typescript
// PROBLEMATIC: Direct console usage
console.log('[Bridge] Session created:', sessionId);
console.warn('[Transport] Connection timeout');
console.error('[Noble] Device scan failed:', error);
```

Desired patterns using existing Logger:
```typescript
// PREFERRED: Use Logger with appropriate level
const logger = new Logger('Bridge', 'info');
logger.info('Session created:', sessionId);
logger.warn('Connection timeout');
logger.error('Device scan failed:', error);
```

Existing Logger class location: `src/logger.ts`
Logger usage example: `src/bridge-server.ts` (partially implemented)

## DOCUMENTATION:
- Existing Logger implementation: `src/logger.ts`
- Log levels defined in: `src/utils.ts` (LogLevel type)
- Environment variable handling: `BLE_MCP_LOG_LEVEL`
- Current usage patterns in `src/start-server.ts`

## OTHER CONSIDERATIONS:

**Migration Strategy**:
1. **Incremental Migration**: Replace console statements file by file
2. **Logger Instance Management**: Each class/module should have its own logger instance
3. **Log Level Mapping**: Map console.log → info, console.warn → warn, console.error → error
4. **Context Preservation**: Maintain all existing log message content and context

**Technical Requirements**:
- Preserve all existing log message content
- Maintain log level semantics (debug, info, warn, error)
- Ensure logger instances are properly scoped to modules
- Keep performance impact minimal
- Support environment-based log level configuration

**Files to Migrate** (based on grep count of 129 console statements):
- All files in `src/` directory with console.* calls
- Focus on core modules first: bridge-server.ts, noble-transport.ts, session-manager.ts
- Maintain existing debug/production log behavior

**Testing Requirements**:
- All existing tests must pass unchanged
- Log output should remain functionally identical
- Environment variable log level control must work
- No performance regression in logging-heavy operations

**Implementation Notes**:
- Use module-scoped logger instances: `const logger = new Logger('ModuleName', logLevel)`
- Import log level from environment: `normalizeLogLevel(process.env.BLE_MCP_LOG_LEVEL)`
- Preserve message formatting and parameters exactly
- Consider adding structured logging for key events if beneficial

**Logging Attribution Fix**:
Current issue: BLE device TX/RX activity is incorrectly attributed to `[WSHandler]` instead of `[NobleTransport]`
```
// INCORRECT CURRENT OUTPUT
[WSHandler] TX.453: A7 B3 02 D9 82 37 00 00 A0 01
[WSHandler] RX.598: A7 B3 03 D9 82 9E 74 37 A0 01 00

// CORRECT DESIRED OUTPUT  
[NobleTransport] TX.453: A7 B3 02 D9 82 37 00 00 A0 01
[NobleTransport] RX.598: A7 B3 03 D9 82 9E 74 37 A0 01 00
```
WSHandler should only log WebSocket routing, NobleTransport should log BLE device communication.