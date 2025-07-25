# Sequence Numbering Design Decision

## Question
Should we add sequence numbering to TX/RX packets from a single number sequence to establish order, or will buffer position provide that?

## Analysis

### Option 1: Global Sequence Number
```typescript
interface LogEntry {
  sequence: number;      // Global incrementing counter
  timestamp: string;
  direction: 'TX' | 'RX';
  hex: string;
}
```

**Pros**:
- Absolute ordering across all packets
- Survives any timestamp issues
- Easy to reference specific packets
- Can detect missing entries

**Cons**:
- Extra field to maintain
- Sequence reset on server restart

### Option 2: Buffer Position
```typescript
// Use array index as implicit sequence
logBuffer[0] = { timestamp: '...', direction: 'TX', hex: '...' };
logBuffer[1] = { timestamp: '...', direction: 'RX', hex: '...' };
```

**Pros**:
- No extra field needed
- Position is implicit sequence

**Cons**:
- Position changes as buffer rotates
- Can't reference absolute packet number
- Harder to correlate across multiple queries

### Option 3: Hybrid Approach (Recommended)
```typescript
interface LogEntry {
  id: number;           // Global sequence, survives rotation
  timestamp: string;    // Primary ordering
  direction: 'TX' | 'RX';
  hex: string;
}

class LogBuffer {
  private sequenceCounter = 0;
  
  push(entry: Omit<LogEntry, 'id'>) {
    this.buffer.push({
      id: this.sequenceCounter++,
      ...entry
    });
  }
}
```

## Recommendation

Use **Option 3 (Hybrid)** for Phase 1:

1. **Sequence ID** for absolute reference
2. **Timestamp** for time-based queries
3. **Buffer position** for client tracking

This provides:
- Unambiguous packet ordering
- Easy correlation ("packet #1234 got response #1235")
- Survives circular buffer rotation
- Simple implementation

## Implementation Notes

```typescript
// Response includes sequence for correlation
{
  "logs": [
    {
      "id": 1234,
      "timestamp": "2024-01-15T10:23:45.123Z",
      "direction": "TX",
      "hex": "A7B3010018000000700201AAA2"
    },
    {
      "id": 1235,
      "timestamp": "2024-01-15T10:23:45.234Z",
      "direction": "RX",
      "hex": "0201E200000017394439454E30303234353632"
    }
  ]
}
```

This allows queries like:
- "Show me packet #1234"
- "Find RX packets between #1234 and #1240"
- "Correlate TX #1234 with next RX"