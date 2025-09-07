import type { WebSocket } from 'ws';
import { BleSession } from './ble-session.js';
import { WebSocketHandler } from './ws-handler.js';
import type { BleConfig } from './noble-transport.js';
import type { SharedState } from './shared-state.js';
import { MetricsTracker } from './connection-metrics.js';

// Constants
const DEFAULT_INACTIVITY_TIMEOUT_SEC = 60;
const CLEANUP_WAIT_TIMEOUT_MS = 6000;
const CLEANUP_CHECK_INTERVAL_MS = 100;

/**
 * SessionManager - Manages BLE session lifecycle and WebSocket routing
 * 
 * Responsibilities:
 * - Maintain registry of active BLE sessions
 * - Route WebSocket connections to appropriate sessions
 * - Handle session cleanup and eviction
 * - Provide session status information
 */
export class SessionManager {
  private sessions = new Map<string, BleSession>();
  private sessionTimers = new Map<string, NodeJS.Timeout>();
  private inactivityTimeoutSec = parseInt(
    process.env.BLE_MCP_IDLE_TIMEOUT || String(DEFAULT_INACTIVITY_TIMEOUT_SEC), 
    10
  );
  private transportCleanupInProgress = false;
  
  constructor(private sharedState?: SharedState) {}

  /**
   * Wait for transport cleanup to complete
   */
  private async waitForCleanup(): Promise<boolean> {
    if (!this.transportCleanupInProgress) return true;
    
    const startTime = Date.now();
    
    while (this.transportCleanupInProgress && (Date.now() - startTime) < CLEANUP_WAIT_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, CLEANUP_CHECK_INTERVAL_MS));
    }
    
    return !this.transportCleanupInProgress;
  }

  /**
   * Check if device is busy with another session
   */
  private findActiveSession(excludeSessionId: string): BleSession | undefined {
    const activeSessions = Array.from(this.sessions.values());
    return activeSessions.find(s => 
      s.sessionId !== excludeSessionId && s.getStatus().hasTransport
    );
  }

  /**
   * Get or create a BLE session
   */
  async getOrCreateSession(sessionId: string, config: BleConfig): Promise<BleSession | null> {
    // Wait for any ongoing transport cleanup
    const cleanupCompleted = await this.waitForCleanup();
    if (!cleanupCompleted) {
      return null;
    }
    
    let session = this.sessions.get(sessionId);
    
    if (!session) {
      // Check if device is busy with another session
      const activeSession = this.findActiveSession(sessionId);
      if (activeSession) {
        return null;
      }
      
      // Create new session
      session = new BleSession(sessionId, config, this.sharedState);
      this.sessions.set(sessionId, session);
      
      // Set up activity tracking
      session.on('activity', () => {
        this.resetSessionTimer(sessionId);
      });
      
      // Auto-cleanup on session cleanup event
      session.once('cleanup', () => {
        this.clearSessionTimer(sessionId);
        this.sessions.delete(sessionId);
        this.updateSharedState();
      });
      
      // Start inactivity timer
      this.resetSessionTimer(sessionId);
      this.updateSharedState();
    } else {
      // Track session reuse in metrics
      MetricsTracker.getInstance().recordSessionReuse(sessionId);
    }
    
    return session;
  }

  /**
   * Attach a WebSocket to a session
   */
  attachWebSocket(session: BleSession, ws: WebSocket): WebSocketHandler {
    const handler = new WebSocketHandler(ws, session, this.sharedState, this);
    
    // Update shared state when WebSocket closes
    handler.once('close', () => {
      this.updateSharedState();
    });
    
    return handler;
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): BleSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): BleSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Remove session immediately with cleanup
   */
  async removeSession(sessionId: string, reason: string = 'connection failed'): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    
    try {
      await session.cleanup(reason);
    } catch {
      // Ignore cleanup errors
    }
    
    this.sessions.delete(sessionId);
    this.updateSharedState();
  }

  /**
   * Update shared state with session information
   */
  private updateSharedState(): void {
    if (!this.sharedState) return;
    
    const activeSessions = Array.from(this.sessions.values());
    const connectedSession = activeSessions.find(s => s.getStatus().connected);
    
    if (connectedSession) {
      const status = connectedSession.getStatus();
      this.sharedState.setConnectionState({ 
        connected: true, 
        deviceName: status.deviceName 
      });
    } else {
      this.sharedState.setConnectionState({ 
        connected: false, 
        deviceName: null 
      });
    }
  }

  /**
   * Reset session inactivity timer
   */
  private resetSessionTimer(sessionId: string): void {
    // Clear existing timer
    const existingTimer = this.sessionTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    // Set new timer
    const timer = setTimeout(async () => {
      const session = this.sessions.get(sessionId);
      if (session) {
        // Remove session from map BEFORE cleanup to prevent race condition
        this.sessions.delete(sessionId);
        this.clearSessionTimer(sessionId);
        this.updateSharedState();
        
        // Mark that transport cleanup is in progress
        this.transportCleanupInProgress = true;
        
        try {
          await session.cleanup('inactivity timeout');
        } catch {
          // Ignore cleanup errors
        } finally {
          this.transportCleanupInProgress = false;
        }
      }
    }, this.inactivityTimeoutSec * 1000);
    
    this.sessionTimers.set(sessionId, timer);
  }
  
  /**
   * Clear session timer
   */
  private clearSessionTimer(sessionId: string): void {
    const timer = this.sessionTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.sessionTimers.delete(sessionId);
    }
  }

  /**
   * Force cleanup all sessions
   */
  async forceCleanupAll(reason: string = 'admin cleanup'): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    const cleanupPromises = sessions.map(session => 
      session.forceCleanup(reason)
    );
    
    await Promise.all(cleanupPromises);
    this.sessions.clear();
  }

  /**
   * Force cleanup sessions for a specific device
   */
  async forceCleanupDevice(deviceName: string, reason: string = 'device cleanup'): Promise<void> {
    const sessions = Array.from(this.sessions.values())
      .filter(s => s.getStatus().deviceName === deviceName);
    
    const cleanupPromises = sessions.map(session => 
      session.forceCleanup(reason)
    );
    
    await Promise.all(cleanupPromises);
    sessions.forEach(s => this.sessions.delete(s.sessionId));
  }

  /**
   * Stop the session manager
   */
  async stop(): Promise<void> {
    // Clear all timers
    for (const timer of this.sessionTimers.values()) {
      clearTimeout(timer);
    }
    this.sessionTimers.clear();
    
    // Clean up all sessions
    await this.forceCleanupAll('manager stopping');
  }
}