import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import { NobleTransport, type BleConfig } from './noble-transport.js';
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
  private lastActivityTime = Date.now();
  
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
      this.resetIdleTimer(); // Reset idle timer on RX activity
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
  }

  /**
   * Remove WebSocket from this session
   */
  removeWebSocket(ws: WebSocket): void {
    this.activeWebSockets.delete(ws);
    console.log(`[Session:${this.sessionId}] Removed WebSocket (${this.activeWebSockets.size} active)`);
    
    // Start grace period if no more WebSockets
    if (this.activeWebSockets.size === 0) {
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
    
    this.lastActivityTime = Date.now();
    this.resetIdleTimer();
    await this.transport.write(data);
  }

  /**
   * Start grace period - keep BLE alive for potential reconnects
   */
  private startGracePeriod(): void {
    console.log(`[Session:${this.sessionId}] Starting ${this.gracePeriodSec}s grace period`);
    
    this.graceTimer = setTimeout(() => {
      console.log(`[Session:${this.sessionId}] Grace period expired - cleaning up`);
      this.cleanup('grace period expired');
    }, this.gracePeriodSec * 1000);
  }

  /**
   * Reset idle timeout - session is still active
   */
  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    
    this.lastActivityTime = Date.now(); // Update activity time
    this.idleTimer = setTimeout(() => {
      const idleTime = Math.round((Date.now() - this.lastActivityTime) / 1000);
      console.log(`[Session:${this.sessionId}] Idle timeout (${idleTime}s since last activity) - cleaning up`);
      this.cleanup('idle timeout');
    }, this.idleTimeoutSec * 1000);
  }

  /**
   * Clean up session and emit cleanup event
   */
  private async cleanup(reason: string, error?: any): Promise<void> {
    console.log(`[Session:${this.sessionId}] Cleaning up (reason: ${reason})`);
    
    // Clear timers
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Close transport
    if (this.transport) {
      try {
        await this.transport.disconnect();
      } catch (e) {
        console.log(`[Session:${this.sessionId}] Transport cleanup error: ${e}`);
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

    this.deviceName = null;
    
    // Emit cleanup event for session manager
    this.emit('cleanup', { sessionId: this.sessionId, reason, error });
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
    const idleTime = Math.round((now - this.lastActivityTime) / 1000);
    
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