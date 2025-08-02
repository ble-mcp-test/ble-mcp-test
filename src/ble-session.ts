import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import { NobleTransport, type BleConfig, type NobleResourceState } from './noble-transport.js';
import type { SharedState } from './shared-state.js';

/**
 * BLE Session - Manages a persistent BLE connection that can survive WebSocket disconnects
 * 
 * Features:
 * - Multiple WebSockets can attach to same BLE connection
 * - Grace period keeps BLE alive after WebSocket disconnect
 * - Idle timeout kicks inactive sessions
 * - Clean state management and logging
 */
export class BleSession extends EventEmitter {
  private transport: NobleTransport | null = null;
  private activeWebSockets = new Set<WebSocket>();
  private deviceName: string | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastTxTime = Date.now();
  public sessionManager?: any; // Reference to SessionManager for cleanup commands
  
  // Timeout configuration (in seconds)
  private gracePeriodSec = parseInt(process.env.BLE_SESSION_GRACE_PERIOD_SEC || process.env.BLE_MCP_GRACE_PERIOD || '60', 10);
  private idleTimeoutSec = parseInt(process.env.BLE_SESSION_IDLE_TIMEOUT_SEC || process.env.BLE_MCP_IDLE_TIMEOUT || '300', 10);
  
  constructor(
    public readonly sessionId: string,
    private config: BleConfig,
    private sharedState: SharedState | null = null
  ) {
    super();
    console.log(`[Session:${sessionId}] Created with grace=${this.gracePeriodSec}s, idle=${this.idleTimeoutSec}s`);
  }

  /**
   * Connect to BLE device (if not already connected)
   */
  async connect(): Promise<string> {
    if (this.transport && this.deviceName) {
      console.log(`[Session:${this.sessionId}] Reusing existing BLE connection to ${this.deviceName}`);
      return this.deviceName;
    }

    console.log(`[Session:${this.sessionId}] Establishing new BLE connection`);
    this.transport = new NobleTransport();
    
    // Set up transport event handlers
    this.transport.on('data', (data: Uint8Array) => {
      this.sharedState?.logPacket('RX', data);
      this.emit('data', data);
    });
    
    this.transport.on('disconnect', () => {
      console.log(`[Session:${this.sessionId}] BLE device disconnected`);
      this.sharedState?.setConnectionState({ connected: false, deviceName: null });
      this.cleanup('device disconnected');
    });
    
    this.transport.on('error', (error) => {
      console.log(`[Session:${this.sessionId}] BLE transport error: ${error}`);
      this.cleanup('transport error', error);
    });

    // Connect and start idle timer
    this.deviceName = await this.transport.connect(this.config);
    this.resetIdleTimer();
    
    console.log(`[Session:${this.sessionId}] Connected to ${this.deviceName}`);
    this.sharedState?.setConnectionState({ connected: true, deviceName: this.deviceName });
    return this.deviceName;
  }

  /**
   * Add WebSocket to this session
   */
  addWebSocket(ws: WebSocket): void {
    this.activeWebSockets.add(ws);
    console.log(`[Session:${this.sessionId}] Added WebSocket (${this.activeWebSockets.size} active)`);
    
    // Cancel grace period if WebSocket reconnects
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
      console.log(`[Session:${this.sessionId}] Cancelled grace period - WebSocket reconnected`);
    }
    
    // Reset idle timer when WebSocket reconnects
    this.lastTxTime = Date.now();
    this.resetIdleTimer();
  }

  /**
   * Remove WebSocket from this session
   */
  removeWebSocket(ws: WebSocket): void {
    const wasActive = this.activeWebSockets.has(ws);
    this.activeWebSockets.delete(ws);
    console.log(`[Session:${this.sessionId}] Removed WebSocket (${this.activeWebSockets.size} active, was active: ${wasActive})`);
    
    // Start grace period if no more WebSockets
    if (this.activeWebSockets.size === 0) {
      console.log(`[Session:${this.sessionId}] No active WebSockets remaining - starting grace period`);
      this.startGracePeriod();
    }
  }

  /**
   * Send data to BLE device and reset idle timer
   */
  async write(data: Uint8Array): Promise<void> {
    if (!this.transport) {
      throw new Error('Not connected');
    }
    
    this.lastTxTime = Date.now();
    this.resetIdleTimer();
    await this.transport.write(data);
  }

  /**
   * Start grace period - keep BLE alive for potential reconnects
   */
  private startGracePeriod(): void {
    console.log(`[Session:${this.sessionId}] Starting ${this.gracePeriodSec}s grace period`);
    
    // Don't clear idle timer - let it run in parallel with grace period
    // This prevents the dead zone where neither timer is active
    
    this.graceTimer = setTimeout(async () => {
      console.log(`[Session:${this.sessionId}] Grace period expired - cleaning up`);
      try {
        await this.cleanup('grace period expired');
      } catch (e) {
        console.error(`[Session:${this.sessionId}] Error during grace period cleanup:`, e);
      }
    }, this.gracePeriodSec * 1000);
    
    // Also ensure idle timer is running during grace period
    if (!this.idleTimer) {
      console.log(`[Session:${this.sessionId}] Starting idle timer during grace period`);
      this.resetIdleTimer();
    }
  }

  /**
   * Reset idle timeout - session is still active
   */
  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    
    // Always set idle timer - it should run even during grace period
    // This prevents zombie connections when grace timer fails
    this.idleTimer = setTimeout(async () => {
      const idleTime = Math.round((Date.now() - this.lastTxTime) / 1000);
      console.log(`[Session:${this.sessionId}] Idle timeout (${idleTime}s since last TX) - cleaning up`);
      try {
        await this.cleanup('idle timeout');
      } catch (e) {
        console.error(`[Session:${this.sessionId}] Error during idle timeout cleanup:`, e);
      }
    }, this.idleTimeoutSec * 1000);
  }

  /**
   * Clean up session with enhanced resource verification and emit cleanup event
   */
  private async cleanup(reason: string, error?: any): Promise<void> {
    console.log(`[Session:${this.sessionId}] Starting enhanced cleanup (reason: ${reason}, hasTransport: ${!!this.transport}, activeWS: ${this.activeWebSockets.size})`);
    
    // Get initial resource state for logging
    const initialState = await NobleTransport.getResourceState();
    console.log(`[Session:${this.sessionId}] Initial Noble resources:`, initialState);
    
    // Check device availability if we have device info
    let deviceAvailable = false;
    if (this.deviceName && this.config?.devicePrefix) {
      try {
        deviceAvailable = await NobleTransport.scanDeviceAvailability(this.config.devicePrefix, 3000);
        console.log(`[Session:${this.sessionId}] Device ${this.deviceName} available: ${deviceAvailable}`);
      } catch (e) {
        console.log(`[Session:${this.sessionId}] Device availability check failed: ${e}`);
      }
    }
    
    // Clear timers
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
      console.log(`[Session:${this.sessionId}] Cleared grace timer`);
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
      console.log(`[Session:${this.sessionId}] Cleared idle timer`);
    }

    // Close transport with progressive cleanup escalation
    if (this.transport) {
      try {
        console.log(`[Session:${this.sessionId}] Disconnecting BLE transport`);
        await this.transport.disconnect();
        console.log(`[Session:${this.sessionId}] BLE transport disconnected successfully`);
      } catch (e) {
        console.log(`[Session:${this.sessionId}] Transport cleanup error: ${e}`);
        
        // Escalate to force cleanup on transport error
        try {
          console.log(`[Session:${this.sessionId}] Escalating to force cleanup`);
          await this.transport.forceCleanup();
        } catch (forceError) {
          console.log(`[Session:${this.sessionId}] Force cleanup also failed: ${forceError}`);
        }
      }
      this.transport = null;
    }

    // Close any remaining WebSockets
    for (const ws of this.activeWebSockets) {
      try {
        ws.close();
      } catch {
        // Ignore WebSocket close errors
      }
    }
    this.activeWebSockets.clear();

    // Verify Noble resource cleanup
    let finalState: NobleResourceState;
    try {
      finalState = await NobleTransport.verifyResourceCleanup(this.deviceName || undefined);
    } catch (e) {
      console.log(`[Session:${this.sessionId}] Resource verification failed: ${e}`);
      finalState = await NobleTransport.getResourceState();
    }
    
    // Log cleanup summary
    const resourcesDelta = initialState.peripheralCount - finalState.peripheralCount;
    const listenersDelta = (initialState.listenerCounts.scanStop + initialState.listenerCounts.discover) - 
                          (finalState.listenerCounts.scanStop + finalState.listenerCounts.discover);
    console.log(`[Session:${this.sessionId}] Cleanup complete - freed ${resourcesDelta} peripherals, ${listenersDelta} listeners, device available: ${deviceAvailable}`);
    
    // Provide user guidance if device becomes unavailable
    if (this.deviceName && !deviceAvailable && !error) {
      await this.notifyDeviceUnavailable();
    }

    this.deviceName = null;
    
    // Emit cleanup event for session manager with enhanced info
    this.emit('cleanup', { 
      sessionId: this.sessionId, 
      reason, 
      error, 
      deviceAvailable, 
      resourceState: finalState,
      resourcesFreed: { peripherals: resourcesDelta, listeners: listenersDelta }
    });
  }

  /**
   * Notify user when device becomes unavailable (future enhancement hook)
   */
  private async notifyDeviceUnavailable(): Promise<void> {
    console.log(`[Session:${this.sessionId}] DEVICE UNAVAILABLE: ${this.deviceName}`);
    console.log(`[Session:${this.sessionId}] User action may be required:`);
    console.log(`[Session:${this.sessionId}]   1. Check if device is powered on and in range`);
    console.log(`[Session:${this.sessionId}]   2. Press device button to wake from sleep`);
    console.log(`[Session:${this.sessionId}]   3. Power cycle device if needed`);
    console.log(`[Session:${this.sessionId}]   4. Check Bluetooth adapter: sudo systemctl restart bluetooth`);
    
    // Future enhancement: emit event for user notification system
    this.emit('deviceUnavailable', { 
      sessionId: this.sessionId, 
      deviceName: this.deviceName,
      guidance: [
        'Check if device is powered on and in range',
        'Press device button to wake from sleep',
        'Power cycle device if needed',
        'Check Bluetooth adapter: sudo systemctl restart bluetooth'
      ]
    });
  }

  /**
   * Force cleanup (for external triggers)
   */
  async forceCleanup(reason: string = 'forced'): Promise<void> {
    await this.cleanup(reason);
  }

  /**
   * Get session status
   */
  getStatus() {
    const now = Date.now();
    const idleTime = Math.round((now - this.lastTxTime) / 1000);
    
    return {
      sessionId: this.sessionId,
      connected: !!this.transport && !!this.deviceName,
      hasTransport: !!this.transport,
      deviceName: this.deviceName,
      activeWebSockets: this.activeWebSockets.size,
      idleTime,
      hasGracePeriod: !!this.graceTimer,
      hasIdleTimer: !!this.idleTimer,
      gracePeriodSec: this.gracePeriodSec,
      idleTimeoutSec: this.idleTimeoutSec
    };
  }
}