import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import { NobleTransport, type BleConfig } from './noble-transport.js';
import type { SharedState } from './shared-state.js';
import { MetricsTracker } from './connection-metrics.js';
import { BLEConnectionError } from './constants.js';

/**
 * BLE Session - Manages a persistent BLE connection that can survive WebSocket disconnects
 * 
 * Features:
 * - Multiple WebSockets can attach to same BLE connection
 * - Single inactivity timeout for session cleanup
 * - Clean state management
 */
export class BleSession extends EventEmitter {
  private transport: NobleTransport | null = null;
  private activeWebSockets = new Set<WebSocket>();
  private deviceName: string | null = null;
  private deviceId: string | null = null;
  private lastActivityTime = Date.now();
  
  constructor(
    public readonly sessionId: string,
    private config: BleConfig,
    private sharedState: SharedState | null = null
  ) {
    super();
  }

  /**
   * Connect to BLE device
   */
  async connect(): Promise<string> {
    const metrics = MetricsTracker.getInstance();
    metrics.recordConnectionAttempt();
    
    try {
      // Create transport and let it handle all BLE operations
      this.transport = new NobleTransport(this.config);
      
      // Set up transport event handlers
      this.transport.on('data', (data: Uint8Array) => {
        this.sharedState?.logPacket('RX', data);
        this.emit('data', data);
      });
      
      this.transport.on('disconnect', () => {
        // Update state when transport disconnects
        this.sharedState?.setConnectionState({ connected: false, deviceName: null });
        // Clear our transport reference since it's now cleaned up
        this.transport = null;
        this.deviceName = null;
        this.deviceId = null;
      });

      // Connect via transport
      const device = await this.transport.connect();
      this.deviceName = device.name;
      this.deviceId = device.id;
      this.recordActivity();
      
      this.sharedState?.setConnectionState({ connected: true, deviceName: this.deviceName });
      metrics.recordConnectionSuccess();
      return this.deviceName || 'unnamed';

    } catch (error: any) {
      // Connection failed - clean up
      metrics.recordConnectionFailure();
      
      // NobleTransport.connect() already calls cleanup() on error,
      // so we just need to clear our reference
      if (this.transport) {
        this.transport = null;
      }
      
      // Re-throw for proper close code mapping
      if (error instanceof BLEConnectionError) {
        throw error;
      } else {
        // Map generic errors to appropriate BLE connection errors
        if (error.message?.includes('timeout')) {
          throw new BLEConnectionError('GATT_CONNECTION_FAILED', `Connection timeout: ${error.message}`);
        } else {
          throw new BLEConnectionError('HARDWARE_NOT_FOUND', error.message || 'Unknown connection error');
        }
      }
    }
  }

  /**
   * Add WebSocket to this session
   */
  addWebSocket(ws: WebSocket): void {
    this.activeWebSockets.add(ws);
    this.recordActivity();
  }

  /**
   * Remove WebSocket from this session
   */
  removeWebSocket(ws: WebSocket): void {
    this.activeWebSockets.delete(ws);
    this.recordActivity();
  }

  /**
   * Send data to BLE device
   */
  async write(data: Uint8Array): Promise<void> {
    if (!this.transport) {
      throw new Error('Not connected');
    }
    
    this.recordActivity();
    await this.transport.write(data);
  }

  /**
   * Record activity timestamp
   */
  private recordActivity(): void {
    this.lastActivityTime = Date.now();
    // Emit activity event so SessionManager can reset its timer
    this.emit('activity');
  }

  /**
   * Cleanup method for session termination
   * @param reason - Reason for cleanup
   * @param closeWebSockets - Close WebSockets during cleanup (default: true)
   */
  async cleanup(reason: string, closeWebSockets: boolean = true): Promise<void> {
    // Clean up transport if we have one
    if (this.transport) {
      try {
        await this.transport.cleanup();
      } catch {
        // Ignore cleanup errors
      }
      this.transport = null;
    }

    // Close WebSockets (unless told not to)
    if (closeWebSockets) {
      for (const ws of this.activeWebSockets) {
        try {
          ws.close();
        } catch {
          // Ignore WebSocket close errors
        }
      }
      this.activeWebSockets.clear();
    }

    // Clear device info
    this.deviceName = null;
    this.deviceId = null;
    
    // Emit cleanup event
    this.emit('cleanup', { 
      sessionId: this.sessionId, 
      reason
    });
  }

  /**
   * External cleanup (for SessionManager)
   * Doesn't close WebSockets - lets the handler do that after sending response
   */
  async forceCleanup(reason: string = 'forced'): Promise<void> {
    await this.cleanup(reason, false);
  }

  /**
   * Get session status
   */
  getStatus() {
    const now = Date.now();
    const inactiveTime = Math.round((now - this.lastActivityTime) / 1000);
    
    return {
      sessionId: this.sessionId,
      connected: !!this.transport && this.transport.isConnected(),
      hasTransport: !!this.transport,
      deviceName: this.deviceName,
      activeWebSockets: this.activeWebSockets.size,
      lastActivityTime: this.lastActivityTime,
      inactiveTime
    };
  }

  /**
   * Get formatted device info for logging
   */
  private getDeviceInfo(): string {
    if (!this.deviceId) {
      return 'unknown device';
    }
    
    // Always show ID, only add name if it's meaningful
    if (this.deviceName && this.deviceName !== 'Unknown' && this.deviceName !== 'unnamed') {
      return `${this.deviceName} (${this.deviceId})`;
    }
    
    return this.deviceId;
  }
}