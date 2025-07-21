#!/usr/bin/env bash

# macOS helper script for WebSocket bridge startup
# This script:
# 1. Detects if running on macOS
# 2. Finds first available CS108 device (or uses env var)
# 3. Starts WebSocket bridge server
# 4. Displays network info for remote access

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_step() {
    echo -e "${BLUE}🔵 $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Configuration
WS_PORT="${WS_PORT:-8080}"
WS_HOST="${WS_HOST:-0.0.0.0}"
CS108_DEVICE_NAME="${CS108_DEVICE_NAME:-}"  # Empty means ANY device

echo "🚀 Starting WebSocket-to-BLE Bridge on macOS"
echo "==========================================="

# Detect OS
print_step "Detecting operating system..."
OS=$(uname -s)
if [ "$OS" != "Darwin" ]; then
    print_error "This script is designed for macOS (Darwin). Detected: $OS"
    print_warning "Use this script on macOS with CS108 hardware"
    exit 1
fi
print_success "Running on macOS"

# Pull latest changes to ensure we have the newest code
print_step "Pulling latest changes..."
CURRENT_BRANCH=$(git branch --show-current)
print_step "Current branch: $CURRENT_BRANCH"
if git pull; then
    print_success "Git pull completed"
else
    print_warning "Git pull failed (might be due to local changes)"
fi

# Check if pnpm is available
print_step "Checking dependencies..."
if ! command -v pnpm &> /dev/null; then
    print_error "pnpm is not installed or not in PATH"
    exit 1
fi
print_success "pnpm is available"

# Install dependencies
print_step "Installing dependencies..."
if pnpm install; then
    print_success "Dependencies installed"
else
    print_error "Failed to install dependencies"
    exit 1
fi

# Clean old builds first
print_step "Cleaning old build artifacts..."
if pnpm clean; then
    print_success "Clean completed"
else
    print_warning "Clean failed (continuing anyway)"
fi

# Build the project
print_step "Building project..."
if pnpm build; then
    print_success "Build completed"
    
    # Verify the build actually created files
    if [ -d "dist" ]; then
        DIST_FILES=$(find dist -type f -name "*.js" | wc -l)
        print_success "Build created $DIST_FILES JavaScript files"
    else
        print_error "Build did not create dist directory!"
        exit 1
    fi
else
    print_error "Build failed"
    exit 1
fi

# Display configuration
print_step "Configuration:"
echo "  WebSocket Port: $WS_PORT"
echo "  WebSocket Host: $WS_HOST"
if [ -n "$CS108_DEVICE_NAME" ]; then
    echo "  CS108 Device: $CS108_DEVICE_NAME"
else
    echo "  CS108 Device: ANY (first available)"
fi

# Get network information
print_step "Network information:"
# Show all available IP addresses
echo "  Available interfaces:"
ifconfig | grep -E "inet.*broadcast" | grep -v "127.0.0.1" | while read line; do
    IP=$(echo $line | awk '{print $2}')
    echo "    - $IP"
done
# Use the first one for display (or could be made configurable)
IP_ADDRESS=$(ifconfig | grep -E "inet.*broadcast" | grep -v "127.0.0.1" | head -1 | awk '{print $2}')
if [ -n "$IP_ADDRESS" ]; then
    echo "  Primary IP: $IP_ADDRESS"
    echo "  WebSocket URL: ws://$IP_ADDRESS:$WS_PORT"
    echo "  mDNS Name: $(hostname).local"
else
    print_warning "Could not determine IP address"
fi

# Check if bridge server is already running
print_step "Checking if WebSocket bridge is already running..."
# Skip lsof check entirely - it's causing hangs on multi-interface systems
# Instead, just try to start and let it fail if port is in use
print_warning "Skipping port check due to multi-interface issues"
# Kill any existing bridge server processes
pkill -f "node.*start-server.js" 2>/dev/null || true
sleep 1

# Get current commit info for troubleshooting
COMMIT_HASH=$(git rev-parse HEAD)
COMMIT_SHORT=$(git rev-parse --short HEAD)
COMMIT_MSG=$(git log -1 --pretty=%B | head -1)
BRANCH_NAME=$(git branch --show-current)

# Create timestamp for consistent file naming
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Path to sandbox VM via SMB share - updated for new project
SANDBOX_PATH="/Volumes/mike-home/web-ble-bridge/tmp"

# Create output directories for logs
mkdir -p tmp
mkdir -p "$SANDBOX_PATH" 2>/dev/null || true

# Clear previous logs for clean debugging  
print_step "Clearing previous WebSocket bridge logs..."
rm -f tmp/ws-server.log
rm -f "$SANDBOX_PATH"/ws-server.log 2>/dev/null || true
print_success "Previous logs cleared"

# Export environment variables for the bridge
export WS_PORT
export WS_HOST
export CS108_DEVICE_NAME

# Signal handler for cleanup
cleanup() {
    echo ""
    print_step "Shutting down WebSocket bridge..."
    
    # Kill any remaining node processes for our server
    pkill -f "node.*start-server.js" 2>/dev/null || true
    
    print_success "WebSocket bridge stopped"
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Start the WebSocket bridge
print_step "Starting WebSocket bridge server..."
echo "  Command: pnpm start"
echo "  Logging to: tmp/ws-server.log"
if [ -d "$SANDBOX_PATH" ]; then
    echo "  Also logging to: $SANDBOX_PATH/ws-server.log"
fi
echo "  Press Ctrl+C to stop"
echo ""

# Create log files
LOG_FILE="tmp/ws-server.log"
SANDBOX_LOG=$([ -d "$SANDBOX_PATH" ] && echo "$SANDBOX_PATH/ws-server.log" || echo "")

# Write header info directly to log files (and display on console)
{
    echo "=== WEBSOCKET-TO-BLE BRIDGE SERVER ==="
    echo "Branch: $BRANCH_NAME"
    echo "Commit: $COMMIT_SHORT - $COMMIT_MSG"
    echo "Full Hash: $COMMIT_HASH"
    echo "Timestamp: $(date)"
    echo "Configuration:"
    echo "  WebSocket Port: $WS_PORT"
    echo "  WebSocket Host: $WS_HOST"
    echo "  CS108 Device: ${CS108_DEVICE_NAME:-ANY}"
    echo "  IP Address: ${IP_ADDRESS:-unknown}"
    echo "  mDNS Name: $(hostname).local"
    echo "======================================"
    echo
    echo "📡 Bridge Server Output:"
    echo "========================"
} | tee "$LOG_FILE" ${SANDBOX_LOG:+$SANDBOX_LOG}

# Now run the service with real-time output (appending to the files we just created)
if command -v unbuffer &> /dev/null; then
    # Use unbuffer for real-time output
    if [ -n "$SANDBOX_LOG" ]; then
        unbuffer pnpm start 2>&1 | tee -a "$LOG_FILE" | tee -a "$SANDBOX_LOG"
    else
        unbuffer pnpm start 2>&1 | tee -a "$LOG_FILE"
    fi
elif command -v script &> /dev/null; then
    # macOS fallback: use script with explicit flush (-a to append)
    if [ -n "$SANDBOX_LOG" ]; then
        script -F -a "$LOG_FILE" bash -c "pnpm start 2>&1 | tee -a '$SANDBOX_LOG'"
    else
        script -F -a "$LOG_FILE" pnpm start
    fi
else
    # Last resort: run directly with stdbuf to disable buffering
    if command -v stdbuf &> /dev/null; then
        stdbuf -o0 -e0 pnpm start 2>&1 | tee -a "$LOG_FILE" ${SANDBOX_LOG:+$SANDBOX_LOG}
    else
        pnpm start 2>&1 | tee -a "$LOG_FILE" ${SANDBOX_LOG:+$SANDBOX_LOG}
    fi
fi