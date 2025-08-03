import type { WebSocket } from 'ws';
import { BleSession } from './ble-session.js';
import { WebSocketHandler } from './ws-handler.js';
import type { BleConfig } from './noble-transport.js';
import type { SharedState } from './shared-state.js';

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
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  constructor(private sharedState?: SharedState) {
    // Start periodic cleanup check
    this.startCleanupTimer();
  }

  /**
   * Get or create a BLE session
   */
  getOrCreateSession(sessionId: string, config: BleConfig): BleSession | null {
    let session = this.sessions.get(sessionId);
    
    if (!session) {
      // Check if any other session has a BLE transport (connected or in grace period)
      const activeSessions = Array.from(this.sessions.values());
      const sessionWithTransport = activeSessions.find(s => s.getStatus().hasTransport);
      
      if (sessionWithTransport && sessionWithTransport.sessionId !== sessionId) {
        // Reject new session - device is busy with a different session
        const status = sessionWithTransport.getStatus();
        console.log(`[SessionManager] Rejecting new session ${sessionId} - device busy with session ${sessionWithTransport.sessionId} (grace period: ${status.hasGracePeriod})`);
        
        // Enhanced logging for debugging
        console.log(`[SessionManager] Active sessions: ${activeSessions.length}`);
        activeSessions.forEach(s => {
          const st = s.getStatus();
          console.log(`  - Session ${st.sessionId}: transport=${st.hasTransport}, grace=${st.hasGracePeriod}, websockets=${st.activeWebSockets}`);
        });
        
        return null;
      }
      
      console.log(`[SessionManager] Creating new session: ${sessionId}`);
      session = new BleSession(sessionId, config, this.sharedState);
      session.sessionManager = this; // Set reference for cleanup commands
      this.sessions.set(sessionId, session);
      
      // Auto-cleanup on session cleanup event
      session.once('cleanup', (info) => {
        console.log(`[SessionManager] Session ${info.sessionId} cleanup: ${info.reason}`);
        this.sessions.delete(sessionId);
        this.updateSharedState();
      });
      
      this.updateSharedState();
    } else {
      console.log(`[SessionManager] Reusing existing session: ${sessionId}`);
      
      // If session is in grace period, log that we're reconnecting
      const status = session.getStatus();
      if (status.hasGracePeriod) {
        console.log(`[SessionManager] Reconnecting to session ${sessionId} during grace period`);
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
   * Start periodic cleanup timer
   */
  private startCleanupTimer(): void {
    // Check for stale sessions every 30 seconds
    this.cleanupInterval = setInterval(async () => {
      try {
        await this.checkStaleSessions();
      } catch (e) {
        console.error('[SessionManager] Error during stale session check:', e);
      }
    }, 30000);
  }

  /**
   * Check for and clean up stale/zombie sessions
   */
  private async checkStaleSessions(): Promise<void> {
    for (const [sessionId, session] of this.sessions) {
      const status = session.getStatus();
      
      // Log session status for monitoring
      if (status.hasGracePeriod || status.idleTime > 60) {
        console.log(`[SessionManager] Session ${sessionId} - ` +
          `WebSockets: ${status.activeWebSockets}, ` +
          `Idle: ${status.idleTime}s, ` +
          `Grace: ${status.hasGracePeriod}, ` +
          `Connected: ${status.connected}, ` +
          `HasTransport: ${status.hasTransport}`);
      }
      
      let shouldCleanup = false;
      let reason = '';
      
      // Detect zombie sessions: has transport but not properly connected
      // Give new connections at least 30 seconds to complete before considering them zombies
      if (status.hasTransport && !status.connected && !status.hasGracePeriod && status.idleTime > 30) {
        shouldCleanup = true;
        reason = `zombie session - has transport but not connected after ${status.idleTime}s`;
      }
      
      // Force cleanup sessions that are idle too long without grace period  
      if (!status.hasGracePeriod && status.activeWebSockets === 0 && 
          status.idleTime > status.idleTimeoutSec + 60) {
        shouldCleanup = true;
        reason = `stale session - idle for ${status.idleTime}s`;
      }
      
      if (shouldCleanup) {
        console.log(`[SessionManager] Cleaning up session ${sessionId}: ${reason}`);
        try {
          // Use force cleanup for zombie/stale sessions (includes resource verification)
          await session.forceCleanup(reason);
        } catch (e) {
          console.error(`[SessionManager] Failed to clean up session ${sessionId}: ${e}`);
        }
      }
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
    
    // Clear cleanup timer
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    // Clean up all sessions
    await this.forceCleanupAll('manager stopping');
  }
}