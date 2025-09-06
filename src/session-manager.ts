import type { WebSocket } from 'ws';
import { BleSession } from './ble-session.js';
import { WebSocketHandler } from './ws-handler.js';
import type { BleConfig } from './noble-transport.js';
import type { SharedState } from './shared-state.js';
import { MetricsTracker } from './connection-metrics.js';
// import { ZombieDetector } from './zombie-detector.js';  // DISABLED for refactoring

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
  private inactivityTimeoutSec = parseInt(process.env.BLE_MCP_GRACE_PERIOD || '60', 10);
  private transportCleanupInProgress = false;
  
  constructor(private sharedState?: SharedState) {
    console.log(`[SessionManager] Initialized with ${this.inactivityTimeoutSec}s inactivity timeout`);
  }

  /**
   * Get or create a BLE session
   */
  async getOrCreateSession(sessionId: string, config: BleConfig): Promise<BleSession | null> {
    // If transport cleanup is in progress, wait for it to complete
    if (this.transportCleanupInProgress) {
      console.log(`[SessionManager] Transport cleanup in progress, waiting...`);
      const maxWaitTime = 6000; // 6 seconds max (to accommodate 2s settling + cleanup time)
      const startTime = Date.now();
      
      while (this.transportCleanupInProgress && (Date.now() - startTime) < maxWaitTime) {
        await new Promise(resolve => setTimeout(resolve, 100)); // Check every 100ms
      }
      
      if (this.transportCleanupInProgress) {
        console.log(`[SessionManager] Transport cleanup timeout - rejecting new session`);
        return null;
      }
      console.log(`[SessionManager] Transport cleanup complete, proceeding with new session`);
    }
    
    let session = this.sessions.get(sessionId);
    
    if (!session) {
      // Check if any OTHER session has a BLE transport (connected or in grace period)
      // Note: We only reject if a DIFFERENT session has the transport
      const activeSessions = Array.from(this.sessions.values());
      const sessionWithTransport = activeSessions.find(s => 
        s.sessionId !== sessionId && s.getStatus().hasTransport
      );
      
      if (sessionWithTransport) {
        // Reject new session - device is busy with a different session
        const status = sessionWithTransport.getStatus();
        console.log(`[SessionManager] Rejecting new session ${sessionId} - device busy with session ${sessionWithTransport.sessionId}`);
        
        // Enhanced logging for debugging
        console.log(`[SessionManager] Active sessions: ${activeSessions.length}`);
        activeSessions.forEach(s => {
          const st = s.getStatus();
          console.log(`  - Session ${st.sessionId}: transport=${st.hasTransport}, websockets=${st.activeWebSockets}`);
        });
        
        return null;
      }
      
      console.log(`[SessionManager] Creating new session: ${sessionId}`);
      session = new BleSession(sessionId, config, this.sharedState);
      this.sessions.set(sessionId, session);
      
      // Set up activity tracking
      session.on('activity', () => {
        this.resetSessionTimer(sessionId);
      });
      
      // Auto-cleanup on session cleanup event
      session.once('cleanup', (info) => {
        console.log(`[SessionManager] Session ${info.sessionId} cleanup: ${info.reason}`);
        this.clearSessionTimer(sessionId);
        this.sessions.delete(sessionId);
        this.updateSharedState();
      });
      
      // Start inactivity timer
      this.resetSessionTimer(sessionId);
      
      this.updateSharedState();
    } else {
      console.log(`[SessionManager] Reusing existing session: ${sessionId}`);
      
      // Track session reuse in metrics
      const metrics = MetricsTracker.getInstance();
      metrics.recordSessionReuse(sessionId);
      
      // Log WebSocket reconnection to existing session
      const status = session.getStatus();
      if (status.activeWebSockets === 0) {
        console.log(`[SessionManager] Reconnecting WebSocket to pooled connection ${sessionId}`);
      } else {
        console.log(`[SessionManager] Attaching additional WebSocket to active session ${sessionId}`);
      }
    }
    
    return session;
  }

  /**
   * Attach a WebSocket to a session
   */
  attachWebSocket(session: BleSession, ws: WebSocket): WebSocketHandler {
    const handler = new WebSocketHandler(ws, session, this.sharedState);
    
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
   * Used when BLE connection fails and session needs immediate removal
   */
  async removeSession(sessionId: string, reason: string = 'connection failed'): Promise<void> {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      console.log(`[SessionManager] Cannot remove session ${sessionId} - not found`);
      return;
    }

    console.log(`[SessionManager] Removing session ${sessionId}: ${reason}`);
    
    try {
      // Clean up BLE resources first
      await session.cleanup(reason);
    } catch (error) {
      console.error(`[SessionManager] Error during session cleanup for ${sessionId}:`, error);
    }
    
    // Remove from sessions map
    this.sessions.delete(sessionId);
    
    // Update shared state to reflect the change
    this.updateSharedState();
    
    console.log(`[SessionManager] Session ${sessionId} removed successfully`);
  }

  /**
   * Update shared state with session information
   */
  private updateSharedState(): void {
    if (!this.sharedState) return;
    
    // Update connection state based on active sessions
    const activeSessions = Array.from(this.sessions.values());
    const connectedSession = activeSessions.find(s => s.getStatus().connected);
    
    if (connectedSession) {
      const status = connectedSession.getStatus();
      this.sharedState.setConnectionState({ 
        connected: true, 
        deviceName: status.deviceName 
      });
    } else {
      // No connected sessions - update state to disconnected
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
        const status = session.getStatus();
        const inactiveTime = status.inactiveTime;
        console.log(`[SessionManager] Session ${sessionId} inactive for ${inactiveTime}s - cleaning up`);
        
        // CRITICAL: Remove session from map BEFORE cleanup to prevent race condition
        // This prevents new WebSockets from getting this session while it's being cleaned up
        this.sessions.delete(sessionId);
        this.clearSessionTimer(sessionId);
        this.updateSharedState();
        
        // Mark that transport cleanup is in progress
        this.transportCleanupInProgress = true;
        
        try {
          await session.cleanup('inactivity timeout');
        } catch (e) {
          console.error(`[SessionManager] Error cleaning up inactive session ${sessionId}:`, e);
        } finally {
          // Cleanup complete - new sessions can now proceed
          this.transportCleanupInProgress = false;
          console.log(`[SessionManager] Transport cleanup complete, new sessions can proceed`);
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
   * Force cleanup all sessions (for admin/testing)
   */
  async forceCleanupAll(reason: string = 'admin cleanup'): Promise<void> {
    console.log(`[SessionManager] Force cleanup all sessions: ${reason}`);
    
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
    console.log(`[SessionManager] Force cleanup sessions for device ${deviceName}: ${reason}`);
    
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
    console.log('[SessionManager] Stopping...');
    
    // Clear all timers
    for (const [sessionId, timer] of this.sessionTimers) {
      clearTimeout(timer);
    }
    this.sessionTimers.clear();
    
    // Clean up all sessions
    await this.forceCleanupAll('manager stopping');
  }
}