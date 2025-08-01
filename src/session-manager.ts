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
        // Reject new session - device is busy
        const status = sessionWithTransport.getStatus();
        console.log(`[SessionManager] Rejecting new session ${sessionId} - device busy with session ${sessionWithTransport.sessionId} (grace period: ${status.hasGracePeriod})`);
        return null;
      }
      
      console.log(`[SessionManager] Creating new session: ${sessionId}`);
      session = new BleSession(sessionId, config, this.sharedState);
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
    }
  }

  /**
   * Start periodic cleanup timer
   */
  private startCleanupTimer(): void {
    // Check for stale sessions every 30 seconds
    this.cleanupInterval = setInterval(() => {
      this.checkStaleSessions();
    }, 30000);
  }

  /**
   * Check for and clean up stale sessions
   */
  private checkStaleSessions(): void {
    for (const [sessionId, session] of this.sessions) {
      const status = session.getStatus();
      
      // Log session status for monitoring
      if (status.hasGracePeriod || status.idleTime > 60) {
        console.log(`[SessionManager] Session ${sessionId} - ` +
          `WebSockets: ${status.activeWebSockets}, ` +
          `Idle: ${status.idleTime}s, ` +
          `Grace: ${status.hasGracePeriod}`);
      }
    }
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
    const cleanupPromises = Array.from(this.sessions.values()).map(session => 
      session.forceCleanup('manager stopping')
    );
    
    await Promise.all(cleanupPromises);
    this.sessions.clear();
  }
}