#!/bin/bash

# Simple service control script for ble-mcp-test
# Usage: ./scripts/service.sh [start|stop|restart|status|logs]

PID_FILE="/tmp/ble-mcp-test.pid"
LOG_FILE="/tmp/ble-mcp-test.log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

function start_service() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            echo -e "${YELLOW}Service already running with PID $PID${NC}"
            return 1
        fi
    fi
    
    echo -e "${GREEN}Starting ble-mcp-test...${NC}"
    
    # Build first if needed
    if [ ! -d "dist" ] || [ "src" -nt "dist" ]; then
        echo "Building project..."
        pnpm run build
    fi
    
    # Start the service
    nohup node dist/start-server.js --mcp-http > "$LOG_FILE" 2>&1 &
    PID=$!
    echo $PID > "$PID_FILE"
    
    # Wait a moment and check if it started
    sleep 2
    if ps -p "$PID" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Service started with PID $PID${NC}"
        echo "  Log file: $LOG_FILE"
        echo "  Health check: http://localhost:8081/health"
        return 0
    else
        echo -e "${RED}✗ Service failed to start${NC}"
        echo "Check logs: tail -f $LOG_FILE"
        rm -f "$PID_FILE"
        return 1
    fi
}

function stop_service() {
    if [ ! -f "$PID_FILE" ]; then
        echo -e "${YELLOW}Service is not running${NC}"
        return 1
    fi
    
    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
        echo -e "${GREEN}Stopping service (PID $PID)...${NC}"
        kill "$PID"
        
        # Wait for graceful shutdown
        for i in {1..5}; do
            if ! ps -p "$PID" > /dev/null 2>&1; then
                break
            fi
            sleep 1
        done
        
        # Force kill if still running
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "Force killing..."
            kill -9 "$PID"
        fi
        
        rm -f "$PID_FILE"
        echo -e "${GREEN}✓ Service stopped${NC}"
    else
        echo -e "${YELLOW}Service was not running (stale PID file)${NC}"
        rm -f "$PID_FILE"
    fi
}

function restart_service() {
    stop_service
    sleep 1
    start_service
}

function service_status() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            echo -e "${GREEN}● ble-mcp-test is running${NC}"
            echo "  PID: $PID"
            echo "  Uptime: $(ps -o etime= -p "$PID" | xargs)"
            echo "  Memory: $(ps -o rss= -p "$PID" | awk '{printf "%.1f MB", $1/1024}')"
            echo "  CPU: $(ps -o %cpu= -p "$PID")%"
            
            # Check health endpoint
            if curl -s http://localhost:8081/health > /dev/null 2>&1; then
                HEALTH=$(curl -s http://localhost:8081/health | python3 -m json.tool 2>/dev/null || echo "{}")
                echo -e "  Health: ${GREEN}✓ Healthy${NC}"
                echo "  $HEALTH" | head -5
            else
                echo -e "  Health: ${RED}✗ Not responding${NC}"
            fi
        else
            echo -e "${YELLOW}○ ble-mcp-test is not running${NC} (stale PID file)"
            rm -f "$PID_FILE"
        fi
    else
        echo -e "${RED}○ ble-mcp-test is not running${NC}"
    fi
}

function show_logs() {
    if [ -f "$LOG_FILE" ]; then
        echo "Showing logs from $LOG_FILE (Ctrl+C to exit):"
        tail -f "$LOG_FILE"
    else
        echo -e "${RED}No log file found${NC}"
    fi
}

# Main command handling
case "$1" in
    start)
        start_service
        ;;
    stop)
        stop_service
        ;;
    restart)
        restart_service
        ;;
    status)
        service_status
        ;;
    logs)
        show_logs
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}"
        echo ""
        echo "Commands:"
        echo "  start    - Start the BLE MCP Test service"
        echo "  stop     - Stop the service"
        echo "  restart  - Restart the service"
        echo "  status   - Show service status and health"
        echo "  logs     - Tail the service logs"
        exit 1
        ;;
esac