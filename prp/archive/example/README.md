# PRP Examples Directory

## Purpose

This directory contains reusable code examples, patterns, and snippets that can be referenced in PRPs. These examples help AI agents understand implementation patterns and best practices specific to this project.

## Structure

Organize examples by topic or feature area:

```
example/
├── websocket/         # WebSocket patterns and examples
├── bluetooth/         # BLE/Bluetooth code examples
├── testing/           # Test patterns and utilities
├── error-handling/    # Error handling patterns
└── typescript/        # TypeScript-specific patterns
```

## What Makes a Good Example?

### Essential Qualities
1. **Self-contained**: Can be understood without extensive context
2. **Well-commented**: Explains why, not just what
3. **Follows conventions**: Uses project standards and style
4. **Tested**: Include test examples when relevant
5. **Realistic**: From actual working code, not simplified

### Example Format

```typescript
/**
 * Example: WebSocket Reconnection with Exponential Backoff
 * 
 * This pattern is used throughout the project for resilient connections.
 * Key features:
 * - Exponential backoff (1s, 2s, 4s, 8s, max 30s)
 * - Event emission for state changes
 * - Proper cleanup on unmount
 */

export class ReconnectingWebSocket {
  private backoffMs = 1000;
  private maxBackoffMs = 30000;
  
  async connect(): Promise<void> {
    try {
      await this.ws.connect();
      this.backoffMs = 1000; // Reset on success
    } catch (error) {
      this.emit('reconnecting', { attempt: this.attempts });
      
      setTimeout(() => {
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
        this.connect();
      }, this.backoffMs);
    }
  }
}
```

## Using Examples in PRPs

When referencing examples in a PRP:

```yaml
- file: prp/example/websocket/reconnection.ts
  why: Standard reconnection pattern used in project
  lines: 15-35  # Optional: specific lines to focus on
```

## Contributing Examples

When adding new examples:

1. **Extract from working code**: Don't write examples from scratch
2. **Generalize appropriately**: Remove project-specific details
3. **Add context**: Explain when and why to use this pattern
4. **Include anti-patterns**: Show what NOT to do
5. **Test the example**: Ensure it actually works

## Example Types to Include

### 1. Design Patterns
- Singleton services
- Factory patterns
- Observer/EventEmitter usage
- Dependency injection

### 2. Error Handling
- Try-catch patterns
- Error recovery strategies
- Logging approaches
- User-facing error messages

### 3. Async Patterns
- Promise handling
- Async/await usage
- Concurrent operations
- Queue management

### 4. Testing Patterns
- Unit test structure
- Mock/stub usage
- Integration test setup
- E2E test patterns

### 5. TypeScript Patterns
- Type guards
- Generic constraints
- Discriminated unions
- Utility types

## Best Practices

### DO:
- ✅ Keep examples focused on one concept
- ✅ Include both code and explanation
- ✅ Show edge case handling
- ✅ Use realistic variable names
- ✅ Include import statements

### DON'T:
- ❌ Include entire files (extract relevant parts)
- ❌ Use outdated patterns
- ❌ Forget error handling
- ❌ Skip type annotations
- ❌ Include sensitive data

## Maintenance

- Review examples quarterly
- Update when patterns change
- Archive outdated examples
- Keep synchronized with actual codebase