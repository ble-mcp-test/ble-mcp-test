/**
 * Zombie Connection Detector
 * 
 * Detects when BLE connections are in a zombie state based on patterns:
 * 1. Multiple "No devices found" errors
 * 2. No active WebSocket connections but failed connection attempts
 * 3. High reconnection rate with failures
 * 4. BLE stack appears stuck (discovery timeouts)
 */

import { MetricsTracker } from './connection-metrics.js';

export interface ZombieDetectionConfig {
  noDeviceFoundThreshold: number;      // Number of "No devices found" errors before flagging
  timeWindowMs: number;                // Time window to count errors within
  failureRateThreshold: number;        // Connection failure rate threshold (0-1)
  reconnectRateThreshold: number;      // Reconnects per minute threshold
  maxTimeWithoutDeviceMs: number;      // Max time without finding device before zombie
}

export interface ZombieDetectionResult {
  isZombie: boolean;
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  recommendedAction: string;
  evidence: string[];
}

interface DeviceFoundError {
  timestamp: number;
  sessionId: string;
  errorMessage: string;
}

export class ZombieDetector {
  private static instance: ZombieDetector;
  private recentErrors: DeviceFoundError[] = [];
  private lastSuccessfulConnection: number | null = null;
  private lastZombieCheck = Date.now();
  
  private config: ZombieDetectionConfig = {
    noDeviceFoundThreshold: 3,       // 3+ "No devices found" errors
    timeWindowMs: 5 * 60 * 1000,     // Within 5 minutes
    failureRateThreshold: 0.5,       // 50%+ failure rate
    reconnectRateThreshold: 10,      // 10+ reconnects per minute
    maxTimeWithoutDeviceMs: 10 * 60 * 1000  // 10 minutes without device
  };
  
  static getInstance(): ZombieDetector {
    if (!ZombieDetector.instance) {
      ZombieDetector.instance = new ZombieDetector();
    }
    return ZombieDetector.instance;
  }
  
  /**
   * Record a "No devices found" error
   */
  recordNoDevicesFoundError(sessionId: string, errorMessage: string): void {
    const now = Date.now();
    
    this.recentErrors.push({
      timestamp: now,
      sessionId,
      errorMessage
    });
    
    // Clean up old errors outside time window
    this.cleanupOldErrors();
    
    console.log(`[ZombieDetector] Recorded "No devices found" error for session ${sessionId} (total recent: ${this.recentErrors.length})`);
  }
  
  /**
   * Record successful device connection
   */
  recordSuccessfulConnection(): void {
    this.lastSuccessfulConnection = Date.now();
    // Clear recent errors on successful connection
    this.recentErrors = [];
    console.log('[ZombieDetector] Successful connection - cleared error history');
  }
  
  /**
   * Check if current state indicates zombie connection
   */
  checkForZombie(activeWebSockets: number = 0): ZombieDetectionResult {
    const now = Date.now();
    const metrics = MetricsTracker.getInstance().getMetrics();
    const evidence: string[] = [];
    let severity: 'low' | 'medium' | 'high' | 'critical' = 'low';
    let reason = '';
    let recommendedAction = 'Continue monitoring';
    
    // Clean up old errors first
    this.cleanupOldErrors();
    
    // Pattern 1: Multiple "No devices found" errors in time window
    const recentErrorCount = this.recentErrors.length;
    if (recentErrorCount >= this.config.noDeviceFoundThreshold) {
      evidence.push(`${recentErrorCount} "No devices found" errors in last ${this.config.timeWindowMs / 1000}s`);
      severity = recentErrorCount > 5 ? 'high' : 'medium';
    }
    
    // Pattern 2: High failure rate with no active WebSockets
    // Require at least 3 attempts to avoid false positives on startup
    if (metrics.totalConnections >= 3) {
      const failureRate = metrics.failedConnections / metrics.totalConnections;
      if (failureRate >= this.config.failureRateThreshold && activeWebSockets === 0) {
        evidence.push(`${(failureRate * 100).toFixed(1)}% connection failure rate with no active WebSockets`);
        severity = failureRate > 0.8 ? 'critical' : 'high';
      }
    }
    
    // Pattern 3: High reconnection rate
    const uptimeMinutes = metrics.uptimeMs / (1000 * 60);
    if (uptimeMinutes > 0) {
      const reconnectsPerMinute = metrics.totalReconnections / uptimeMinutes;
      if (reconnectsPerMinute >= this.config.reconnectRateThreshold) {
        evidence.push(`${reconnectsPerMinute.toFixed(1)} reconnects per minute`);
        severity = reconnectsPerMinute > 20 ? 'critical' : 'high';
      }
    }
    
    // Pattern 4: Long time without successful device discovery
    if (this.lastSuccessfulConnection) {
      const timeSinceSuccess = now - this.lastSuccessfulConnection;
      if (timeSinceSuccess > this.config.maxTimeWithoutDeviceMs && recentErrorCount > 0) {
        evidence.push(`${Math.floor(timeSinceSuccess / 1000)}s since last successful connection`);
        severity = timeSinceSuccess > 20 * 60 * 1000 ? 'critical' : 'high';
      }
    }
    
    // Pattern 5: Active reconnection attempts but no WebSockets (classic zombie)
    if (metrics.totalReconnections > metrics.successfulConnections && activeWebSockets === 0) {
      evidence.push('More reconnection attempts than successful connections with no active clients');
      severity = 'high';
    }
    
    // Determine if this is a zombie state
    const isZombie = evidence.length >= 2 || severity === 'critical';
    
    if (isZombie) {
      reason = 'BLE stack appears to be in zombie state based on multiple indicators';
      
      switch (severity) {
        case 'critical':
          recommendedAction = 'Restart Bluetooth service immediately: sudo systemctl restart bluetooth';
          break;
        case 'high':
          recommendedAction = 'Restart Bluetooth service: sudo systemctl restart bluetooth';
          break;
        case 'medium':
          recommendedAction = 'Monitor closely, consider Bluetooth restart if pattern continues';
          break;
        default:
          recommendedAction = 'Continue monitoring';
      }
      
      // Record zombie detection in metrics
      if (severity === 'high' || severity === 'critical') {
        MetricsTracker.getInstance().recordZombieDetected();
      }
    }
    
    this.lastZombieCheck = now;
    
    return {
      isZombie,
      reason,
      severity,
      recommendedAction,
      evidence
    };
  }
  
  /**
   * Get recent error history for debugging
   */
  getRecentErrors(): DeviceFoundError[] {
    return [...this.recentErrors];
  }
  
  /**
   * Clear all tracking data (for testing/reset)
   */
  reset(): void {
    this.recentErrors = [];
    this.lastSuccessfulConnection = null;
    this.lastZombieCheck = Date.now();
  }
  
  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<ZombieDetectionConfig>): void {
    this.config = { ...this.config, ...newConfig };
    console.log('[ZombieDetector] Configuration updated:', this.config);
  }
  
  /**
   * Remove old errors outside the time window
   */
  private cleanupOldErrors(): void {
    const cutoff = Date.now() - this.config.timeWindowMs;
    const initialCount = this.recentErrors.length;
    
    this.recentErrors = this.recentErrors.filter(error => error.timestamp >= cutoff);
    
    const removed = initialCount - this.recentErrors.length;
    if (removed > 0) {
      console.log(`[ZombieDetector] Cleaned up ${removed} old errors`);
    }
  }
}