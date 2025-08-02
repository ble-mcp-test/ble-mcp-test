import type { WebSocket } from 'ws';
import { BleSession } from './ble-session.js';
import { WebSocketHandler } from './ws-handler.js';
import { NobleTransport, type BleConfig, type NobleResourceState } from './noble-transport.js';
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
   * Check for and clean up stale/zombie sessions with enhanced detection
   */
  private async checkStaleSessions(): Promise<void> {
    const zombieSessions = [];
    
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
      
      // Detect zombie sessions: has transport but not properly connected
      if (status.hasTransport && !status.connected && !status.hasGracePeriod) {
        zombieSessions.push({ sessionId, session, reason: 'zombie session - has transport but not connected' });
        console.log(`[SessionManager] Detected zombie session ${sessionId} - has transport but not connected`);
      }
      
      // Force cleanup sessions that are idle too long without grace period  
      if (!status.hasGracePeriod && status.activeWebSockets === 0 && 
          status.idleTime > status.idleTimeoutSec + 60) {
        zombieSessions.push({ sessionId, session, reason: `stale session - idle for ${status.idleTime}s` });
        console.log(`[SessionManager] Detected stale session ${sessionId} - idle for ${status.idleTime}s`);
      }
    }
    
    // Clean up detected zombie/stale sessions
    for (const { sessionId, session, reason } of zombieSessions) {
      try {
        await this.performVerifiedCleanup(session, reason);
      } catch (e) {
        console.error(`[SessionManager] Failed to clean up session ${sessionId}: ${e}`);
      }
    }
  }

  /**
   * Perform verified cleanup with Noble resource verification
   */
  private async performVerifiedCleanup(session: BleSession, reason: string): Promise<void> {
    const sessionId = session.sessionId;
    console.log(`[SessionManager] Performing verified cleanup for session ${sessionId}: ${reason}`);
    
    // Get initial Noble resource state
    const initialState = await NobleTransport.getResourceState();
    
    // Force cleanup the session
    await session.forceCleanup(reason);
    
    // Verify cleanup was effective
    const cleanupVerification = await this.verifySessionCleanup(sessionId, initialState);
    
    if (!cleanupVerification.success) {
      console.log(`[SessionManager] Cleanup verification failed for ${sessionId} - triggering Noble reset`);
      await this.triggerNobleReset(`cleanup verification failed: ${cleanupVerification.reason}`);
    }
  }

  /**
   * Verify session cleanup was successful
   */
  private async verifySessionCleanup(sessionId: string, initialState: NobleResourceState): Promise<{success: boolean, reason?: string}> {
    console.log(`[SessionManager] Verifying cleanup for session ${sessionId}`);
    
    // Wait for cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const finalState = await NobleTransport.getResourceState();
    
    // Check if resources were properly freed
    const resourcesFreed = initialState.peripheralCount - finalState.peripheralCount;
    const listenersFreed = (initialState.listenerCounts.scanStop + initialState.listenerCounts.discover) - 
                          (finalState.listenerCounts.scanStop + finalState.listenerCounts.discover);
    
    console.log(`[SessionManager] Cleanup verification - freed ${resourcesFreed} peripherals, ${listenersFreed} listeners`);
    
    // Check for excessive resource accumulation
    if (finalState.listenerCounts.scanStop > 90) {
      return { success: false, reason: `scanStop listeners excessive: ${finalState.listenerCounts.scanStop}` };
    }
    
    if (finalState.listenerCounts.discover > 10) {
      return { success: false, reason: `discover listeners excessive: ${finalState.listenerCounts.discover}` };
    }
    
    if (finalState.peripheralCount > 100) {
      return { success: false, reason: `peripheral cache excessive: ${finalState.peripheralCount}` };
    }
    
    return { success: true };
  }

  /**
   * Trigger Noble stack reset for escalated cleanup
   */
  private async triggerNobleReset(reason: string): Promise<void> {
    console.log(`[SessionManager] Triggering Noble stack reset: ${reason}`);
    
    try {
      // Force cleanup all Noble resources
      await NobleTransport.forceCleanupResources();
      
      // Create temporary transport to trigger stack reset
      const resetTransport = new NobleTransport();
      await resetTransport.resetNobleStack();
      
      console.log('[SessionManager] Noble stack reset completed successfully');
    } catch (e) {
      console.error(`[SessionManager] Noble stack reset failed: ${e}`);
      
      // Log detailed recovery instructions for manual intervention
      console.error('');
      console.error('⚠️  NOBLE STACK RESET FAILED - MANUAL INTERVENTION REQUIRED');
      console.error('');
      console.error('ACTION REQUIRED: Ask the user to:');
      console.error('  1. Restart the BLE service: sudo systemctl restart bluetooth');
      console.error('  2. Restart the application completely');
      console.error('  3. Check for hardware issues if problem persists');
      console.error('  4. Consider system reboot if Bluetooth stack is corrupted');
      console.error('');
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