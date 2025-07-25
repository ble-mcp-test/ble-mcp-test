# MCP Log Streaming Approaches

## The Challenge

MCP (Model Context Protocol) is fundamentally request/response based. When Claude calls a tool, it waits for a single response. This doesn't naturally fit real-time log streaming where logs continuously arrive over time.

## Approach 1: Polling with State (Recommended)

Add a `ble_logs` tool that returns recent logs since the last query:

```typescript
{
  name: "ble_logs",
  description: "Get recent BLE communication logs",
  inputSchema: {
    properties: {
      since: {
        type: "string",
        description: "ISO timestamp or 'last' to get logs since last query"
      },
      follow: {
        type: "boolean", 
        description: "Keep checking for new logs (returns after timeout or log count)"
      },
      timeout: {
        type: "number",
        description: "Max time to wait for logs when following (ms)",
        default: 5000
      }
    }
  }
}
```

Usage pattern:
```
User: Show me what's happening with the BLE connection
Claude: I'll monitor the BLE logs for you.
[Calls ble_logs with follow=true, timeout=5000]
[Shows logs that arrived in that 5 second window]
[Calls ble_logs again with since='last' if user wants more]
```

## Approach 2: Resource URIs

MCP supports returning resource URIs that can be fetched separately:

```typescript
// Tool returns a streaming log URI
{
  type: "resource",
  uri: "ble://logs/stream",
  mimeType: "text/plain",
  streaming: true
}
```

However, Claude would need to understand how to consume streaming resources, which isn't standard yet.

## Approach 3: Hybrid - Buffered Snapshots

The MCP server maintains a circular buffer of recent logs:

```typescript
class LogBuffer {
  private logs: LogEntry[] = [];
  private maxSize = 1000;
  private subscribers: Map<string, number> = new Map();
  
  addLog(entry: LogEntry) {
    this.logs.push(entry);
    if (this.logs.length > this.maxSize) {
      this.logs.shift();
    }
  }
  
  getLogsSince(subscriberId: string, timestamp?: Date): LogEntry[] {
    // Return logs since timestamp or last fetch for this subscriber
    const lastIndex = this.subscribers.get(subscriberId) || 0;
    const newLogs = this.logs.slice(lastIndex);
    this.subscribers.set(subscriberId, this.logs.length);
    return newLogs;
  }
}
```

## Approach 4: Notification System (Future MCP)

Future MCP versions might support server-initiated notifications:

```typescript
// Hypothetical future API
server.notify('ble.log', {
  level: 'info',
  message: '[TX] A7B302D98237000A000',
  timestamp: new Date().toISOString()
});
```

## Recommendation

For now, use **Approach 1 (Polling with State)** because:

1. **Works with current MCP** - No protocol extensions needed
2. **Natural for Claude** - Can decide when to check logs based on context
3. **Efficient** - Only fetches new logs since last check
4. **Flexible** - Can do quick checks or longer monitoring periods

Example interaction:
```
User: Monitor the connection while I test something
Claude: I'll watch the logs. Let me know when you're done.
[Calls ble_logs with follow=true every 5 seconds]
[Shows relevant activity as it happens]
[Stops when user says they're done]
```

## Implementation Sketch

```typescript
// In MCP server
private logBuffer = new CircularBuffer<LogEntry>(1000);
private clientPositions = new Map<string, number>();

tools.addTool({
  name: 'ble_logs',
  handler: async (params) => {
    const clientId = context.clientId;
    const since = params.since === 'last' 
      ? this.clientPositions.get(clientId) 
      : params.since;
    
    if (params.follow) {
      // Wait up to timeout for new logs
      const endTime = Date.now() + (params.timeout || 5000);
      while (Date.now() < endTime) {
        const logs = this.logBuffer.getEntriesSince(since);
        if (logs.length > 0) {
          this.clientPositions.set(clientId, this.logBuffer.position);
          return { logs, hasMore: true };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Return whatever we have
    const logs = this.logBuffer.getEntriesSince(since);
    this.clientPositions.set(clientId, this.logBuffer.position);
    return { logs, hasMore: false };
  }
});
```

This gives us pseudo-streaming that feels natural in Claude's conversational model while working within MCP's request/response constraints.