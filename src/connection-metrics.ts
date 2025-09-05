/**
 * Connection metrics tracking for monitoring BLE stability
 */

export interface ConnectionMetrics {
  // Connection counts
  totalConnections: number;
  successfulConnections: number;
  failedConnections: number;
  
  // Reconnection tracking
  totalReconnections: number;
  reconnectionsPerSession: Map<string, number>;
  
  // Resource leak indicators
  maxListenerCount: number;
  maxPeripheralCount: number;
  listenerWarnings: number;
  
  // Session lifecycle
  activeSessions: number;
  totalSessions: number;
  sessionDurations: number[];  // in milliseconds
  
  // Timing metrics
  averageConnectionTime: number;
  lastConnectionTime: number;
  
  // System health
  lastResourceCheck: Date;
  resourceLeakDetected: boolean;
  zombieConnectionsDetected: number;
  bluetoothRestarts: number;
  
  // Uptime
  serviceStartTime: Date;
  uptimeMs: number;
}

export class MetricsTracker {
  private metrics: ConnectionMetrics = {
    totalConnections: 0,
    successfulConnections: 0,
    failedConnections: 0,
    totalReconnections: 0,
    reconnectionsPerSession: new Map(),
    maxListenerCount: 0,
    maxPeripheralCount: 0,
    listenerWarnings: 0,
    activeSessions: 0,
    totalSessions: 0,
    sessionDurations: [],
    averageConnectionTime: 0,
    lastConnectionTime: 0,
    lastResourceCheck: new Date(),
    resourceLeakDetected: false,
    zombieConnectionsDetected: 0,
    bluetoothRestarts: 0,
    serviceStartTime: new Date(),
    uptimeMs: 0
  };
  
  private sessionStartTimes = new Map<string, number>();
  private connectionStartTime: number | null = null;
  
  // Singleton instance
  private static instance: MetricsTracker;
  
  static getInstance(): MetricsTracker {
    if (!MetricsTracker.instance) {
      MetricsTracker.instance = new MetricsTracker();
    }
    return MetricsTracker.instance;
  }
  
  // Connection tracking
  recordConnectionAttempt(): void {
    this.metrics.totalConnections++;
    this.connectionStartTime = Date.now();
  }
  
  recordConnectionSuccess(): void {
    this.metrics.successfulConnections++;
    if (this.connectionStartTime) {
      this.metrics.lastConnectionTime = Date.now() - this.connectionStartTime;
      this.updateAverageConnectionTime(this.metrics.lastConnectionTime);
      this.connectionStartTime = null;
    }
  }
  
  recordConnectionFailure(): void {
    this.metrics.failedConnections++;
    this.connectionStartTime = null;
  }
  
  // Reconnection tracking
  recordReconnection(sessionId: string): void {
    this.metrics.totalReconnections++;
    const count = this.metrics.reconnectionsPerSession.get(sessionId) || 0;
    this.metrics.reconnectionsPerSession.set(sessionId, count + 1);
  }
  
  // Session tracking
  recordSessionStart(sessionId: string): void {
    this.metrics.totalSessions++;
    this.metrics.activeSessions++;
    this.sessionStartTimes.set(sessionId, Date.now());
  }
  
  recordSessionEnd(sessionId: string): void {
    this.metrics.activeSessions = Math.max(0, this.metrics.activeSessions - 1);
    const startTime = this.sessionStartTimes.get(sessionId);
    if (startTime) {
      const duration = Date.now() - startTime;
      this.metrics.sessionDurations.push(duration);
      // Keep only last 100 durations
      if (this.metrics.sessionDurations.length > 100) {
        this.metrics.sessionDurations.shift();
      }
      this.sessionStartTimes.delete(sessionId);
    }
  }
  
  // Resource tracking
  updateResourceState(state: {
    listenerCounts: Record<string, number>;
    peripheralCount: number;
  }): void {
    this.metrics.lastResourceCheck = new Date();
    
    // Track max listener counts
    const totalListeners = Object.values(state.listenerCounts).reduce((a, b) => a + b, 0);
    this.metrics.maxListenerCount = Math.max(this.metrics.maxListenerCount, totalListeners);
    
    // Track max peripheral count
    this.metrics.maxPeripheralCount = Math.max(this.metrics.maxPeripheralCount, state.peripheralCount);
    
    // Check for resource leaks
    if (totalListeners > 50 || state.peripheralCount > 10) {
      this.metrics.resourceLeakDetected = true;
    }
    
    // Check for listener warnings (Noble warns at 11 listeners per event)
    Object.values(state.listenerCounts).forEach(count => {
      if (count > 10) {
        this.metrics.listenerWarnings++;
      }
    });
  }
  
  // Zombie detection
  recordZombieDetected(): void {
    this.metrics.zombieConnectionsDetected++;
  }
  
  recordBluetoothRestart(): void {
    this.metrics.bluetoothRestarts++;
  }
  
  // Get metrics
  getMetrics(): ConnectionMetrics {
    this.metrics.uptimeMs = Date.now() - this.metrics.serviceStartTime.getTime();
    return { ...this.metrics, reconnectionsPerSession: new Map(this.metrics.reconnectionsPerSession) };
  }
  
  getHealthReport(): {
    healthy: boolean;
    issues: string[];
    recommendations: string[];
  } {
    const issues: string[] = [];
    const recommendations: string[] = [];
    
    // Check failure rate
    if (this.metrics.totalConnections > 0) {
      const failureRate = this.metrics.failedConnections / this.metrics.totalConnections;
      if (failureRate > 0.2) {
        issues.push(`High failure rate: ${(failureRate * 100).toFixed(1)}%`);
      }
    }
    
    // Check for resource leaks
    if (this.metrics.resourceLeakDetected) {
      issues.push('Resource leak detected');
      recommendations.push('Restart service to clear resources');
    }
    
    // Check listener warnings
    if (this.metrics.listenerWarnings > 0) {
      issues.push(`Listener warnings: ${this.metrics.listenerWarnings}`);
      recommendations.push('Check for listener memory leaks');
    }
    
    // Check zombie connections
    if (this.metrics.zombieConnectionsDetected > 0) {
      issues.push(`Zombie connections detected: ${this.metrics.zombieConnectionsDetected}`);
      recommendations.push('Consider restarting Bluetooth service');
    }
    
    // Check reconnection rates
    for (const [sessionId, count] of this.metrics.reconnectionsPerSession) {
      if (count > 10) {
        issues.push(`Session ${sessionId} has ${count} reconnections`);
      }
    }
    
    // Calculate max safe connections before resource issues
    const safeConnectionsEstimate = this.estimateSafeConnections();
    recommendations.push(`Estimated safe connections before issues: ${safeConnectionsEstimate}`);
    
    return {
      healthy: issues.length === 0,
      issues,
      recommendations
    };
  }
  
  // Estimate how many connections we can handle before resource issues
  private estimateSafeConnections(): number {
    if (this.metrics.totalConnections === 0) {
      return 100; // Default estimate
    }
    
    // Based on when we've seen issues
    if (this.metrics.zombieConnectionsDetected > 0) {
      const connectionsPerZombie = Math.floor(this.metrics.totalConnections / this.metrics.zombieConnectionsDetected);
      return Math.max(10, connectionsPerZombie - 5); // Conservative estimate
    }
    
    // Based on listener growth
    if (this.metrics.maxListenerCount > 0) {
      const listenerGrowthRate = this.metrics.maxListenerCount / this.metrics.totalConnections;
      const maxSafeListeners = 100; // Noble gets unhappy above this
      return Math.floor(maxSafeListeners / listenerGrowthRate);
    }
    
    return 100; // Fallback
  }
  
  private updateAverageConnectionTime(newTime: number): void {
    const alpha = 0.1; // Exponential moving average factor
    if (this.metrics.averageConnectionTime === 0) {
      this.metrics.averageConnectionTime = newTime;
    } else {
      this.metrics.averageConnectionTime = alpha * newTime + (1 - alpha) * this.metrics.averageConnectionTime;
    }
  }
  
  // Reset metrics (useful for testing)
  reset(): void {
    this.metrics = {
      totalConnections: 0,
      successfulConnections: 0,
      failedConnections: 0,
      totalReconnections: 0,
      reconnectionsPerSession: new Map(),
      maxListenerCount: 0,
      maxPeripheralCount: 0,
      listenerWarnings: 0,
      activeSessions: 0,
      totalSessions: 0,
      sessionDurations: [],
      averageConnectionTime: 0,
      lastConnectionTime: 0,
      lastResourceCheck: new Date(),
      resourceLeakDetected: false,
      zombieConnectionsDetected: 0,
      bluetoothRestarts: 0,
      serviceStartTime: new Date(),
      uptimeMs: 0
    };
    this.sessionStartTimes.clear();
    this.connectionStartTime = null;
  }
}