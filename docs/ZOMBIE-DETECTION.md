# 🧟 Zombie Connection Detection

This system automatically detects when BLE connections are in a "zombie state" - appearing connected but unable to discover or communicate with devices.

## How It Works

The zombie detector monitors several patterns:

### Detection Patterns

1. **"No devices found" errors**: Multiple scan timeouts in a short period
2. **High failure rate + no WebSockets**: Connections failing but no active clients
3. **Excessive reconnections**: High reconnect rate indicates instability  
4. **Discovery timeouts**: Long periods without successful device discovery
5. **Stale connection attempts**: More reconnect attempts than successful connections

### Severity Levels

- **Low**: Single indicator, continue monitoring
- **Medium**: Multiple indicators, watch closely
- **High**: Clear zombie pattern, recommend Bluetooth restart
- **Critical**: Severe zombie state, automatic cleanup triggered

## Usage

### Check for Zombies

```bash
# View current metrics including zombie detection
pnpm metrics

# Get detailed zombie analysis via HTTP
curl http://localhost:8081/metrics | jq '.metrics.resources'
```

### Manual Recovery

```bash
# Restart Bluetooth service (requires sudo)
pnpm restart-bluetooth

# Restart bridge server after Bluetooth restart
pnpm pm2:restart
```

### Automatic Detection

The session manager runs zombie detection every 30 seconds:
- **Critical zombies**: Automatically cleanup all sessions
- **High severity**: Log warnings with recommended actions
- **Medium/Low**: Continue monitoring and logging

## Detection Criteria

| Pattern | Threshold | Action |
|---------|-----------|---------|
| "No devices found" errors | 3+ in 5 minutes | Medium severity |
| Connection failure rate | >50% with no WebSockets | High severity |
| Reconnection rate | >10 per minute | High severity |  
| Time without device | >10 minutes with errors | High severity |
| Reconnects > connections | With no active clients | High severity |

## Automatic Actions

### Session Manager Integration
- Runs zombie check every 30 seconds during cleanup
- Critical zombies trigger immediate session cleanup
- Records zombie detections in metrics
- Logs detailed evidence and recommendations

### Logging Examples

```
[SessionManager] 🧟 ZOMBIE CONNECTION DETECTED!
  Severity: high
  Reason: BLE stack appears to be in zombie state based on multiple indicators
  Recommended Action: Restart Bluetooth service: sudo systemctl restart bluetooth
  Evidence:
    - 5 "No devices found" errors in last 300s
    - 67.0% connection failure rate with no active WebSockets
    - 234s since last successful connection
```

## MCP Tools (when available)

- `get_metrics`: View connection metrics including zombie counts
- `check_zombie`: Detailed zombie analysis with recent error history
- `get_connection_state`: Current connection state

## Prevention

### Best Practices
1. **Monitor metrics regularly**: `pnpm metrics`
2. **Restart on high failure rates**: >50% connection failures
3. **Don't ignore "No devices found"**: Multiple occurrences indicate problems
4. **Clean restarts**: Always restart bridge after Bluetooth service restart
5. **Watch PM2 restart count**: High restart frequency indicates systemic issues

### Configuration

The zombie detector can be configured by modifying thresholds in `src/zombie-detector.ts`:

```typescript
private config: ZombieDetectionConfig = {
  noDeviceFoundThreshold: 3,       // Errors before flagging
  timeWindowMs: 5 * 60 * 1000,     // Time window (5 minutes)
  failureRateThreshold: 0.5,       // 50% failure rate threshold
  reconnectRateThreshold: 10,      // Reconnects per minute
  maxTimeWithoutDeviceMs: 10 * 60 * 1000  // Max time without discovery
};
```

## Troubleshooting

### Common Scenarios

1. **Frequent "No devices found"**: Device may be off, out of range, or BLE stack stuck
2. **High reconnection rate**: WebSocket instability, check network connection
3. **Zero active WebSockets but high failures**: Likely zombie state - restart Bluetooth
4. **PM2 restart correlation**: If PM2 restarts correlate with zombie detection, indicates resource exhaustion

### Recovery Steps

1. Check zombie status: `pnpm metrics`
2. If high severity: `pnpm restart-bluetooth`
3. Always restart bridge: `pnpm pm2:restart`  
4. Verify recovery: Check metrics show cleared state
5. Monitor: Watch for pattern recurrence

The system will automatically detect and warn about zombie states, providing specific recommendations for recovery.