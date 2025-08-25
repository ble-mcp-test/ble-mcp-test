# Service Management Guide

## Quick Start

### Option 1: Simple Service Script (Recommended for Development)
```bash
# Start the service
./scripts/service.sh start

# Stop the service
./scripts/service.sh stop

# Restart the service
./scripts/service.sh restart

# Check status
./scripts/service.sh status

# View logs
./scripts/service.sh logs
```

### Option 2: PM2 (Recommended for Production)

PM2 is included as a dependency, no global install needed.

#### Use PM2 commands
```bash
# Start service
pnpm run pm2:start

# Stop service
pnpm run pm2:stop

# Restart service
pnpm run pm2:restart

# View status
pnpm run pm2:status

# View logs
pnpm run pm2:logs

# Monitor (interactive dashboard)
pnpm run pm2:monitor

# Set up auto-start on system boot
pnpm run pm2:startup
pm2 save
```

### Option 3: Direct Node.js (Simple Testing)
```bash
# Foreground (see output directly)
pnpm start:http

# Background with nohup
nohup pnpm start:http > /tmp/ble.log 2>&1 &
```

## Service Details

- **WebSocket Port**: 8080
- **HTTP/Health Port**: 8081
- **Health Check**: http://localhost:8081/health
- **MCP Info**: http://localhost:8081/mcp/info

## Why Not Systemd?

We moved away from systemd because:
1. Noble.js has initialization issues in systemd context
2. Bluetooth state changes aren't properly detected
3. Added complexity without significant benefits for this use case

## PM2 Benefits

- Process management designed for Node.js
- Automatic restarts on crash
- Log management and rotation
- Memory limit restart
- CPU clustering support
- Built-in monitoring
- Works consistently across environments

## Troubleshooting

### Service won't start
```bash
# Check if ports are in use
lsof -i :8080
lsof -i :8081

# Kill any stuck processes
pkill -f "node.*start-server"

# Check Bluetooth is enabled
hciconfig -a
sudo systemctl status bluetooth

# Check device is available
pnpm run check:device
```

### Connection issues
```bash
# Restart Bluetooth service
sudo systemctl restart bluetooth

# Check logs
./scripts/service.sh logs
# or with PM2
pm2 logs ble-mcp-test --lines 100
```

### Clean restart
```bash
# With service script
./scripts/service.sh restart

# With PM2
pm2 restart ble-mcp-test

# Nuclear option - full cleanup
pkill -f "node.*start-server"
sudo systemctl restart bluetooth
./scripts/service.sh start
```

## Environment Variables

Create `.env.local` file:
```env
BLE_MCP_WS_PORT=8080
BLE_MCP_LOG_LEVEL=debug
BLE_MCP_GRACE_PERIOD=60
BLE_MCP_IDLE_TIMEOUT=180
```

## For CI/CD

The service script automatically builds if needed:
```bash
./scripts/service.sh start  # Will build if dist/ is missing or outdated
```

With PM2 for production:
```bash
pm2 start ecosystem.config.js --env production
pm2 save
```