import { randomUUID } from 'crypto';
import { Logger } from './logger.js';
import { ConnectionMutex } from './connection-mutex.js';
import { NobleTransport } from './noble-transport.js';
import { ServerState, StateMachine } from './state-machine.js';

export interface ConnectionContextOptions {
  idleTimeout: number;
  onEvictionWarning: (gracePeriodMs: number) => void;
  onForceCleanup: () => void;
}

export class ConnectionContext {
  private readonly token: string;
  private readonly logger: Logger;
  private readonly mutex: ConnectionMutex;
  private readonly stateMachine: StateMachine;
  private readonly options: ConnectionContextOptions;
  
  private idleTimer: NodeJS.Timeout | null = null;
  private evictionTimer: NodeJS.Timeout | null = null;
  private wsConnection: any = null;
  private bleTransport: NobleTransport | null = null;
  private cleanupComplete = false;
  
  private connectedAt: string;
  private lastActivity: string;
  private deviceName?: string;
  
  constructor(
    mutex: ConnectionMutex,
    stateMachine: StateMachine,
    options: ConnectionContextOptions
  ) {
    this.token = randomUUID();
    this.logger = new Logger(`ConnectionContext[${this.token.substring(0, 8)}]`);
    this.mutex = mutex;
    this.stateMachine = stateMachine;
    this.options = options;
    this.connectedAt = new Date().toISOString();
    this.lastActivity = new Date().toISOString();
  }
  
  getToken(): string {
    return this.token;
  }
  
  setWebSocket(ws: any): void {
    this.wsConnection = ws;
  }
  
  setBleTransport(transport: NobleTransport): void {
    this.bleTransport = transport;
  }
  
  setDeviceName(name: string): void {
    this.deviceName = name;
  }
  
  getConnectionInfo() {
    return {
      token: this.token,
      connected: true,
      deviceName: this.deviceName,
      connectedAt: this.connectedAt,
      lastActivity: this.lastActivity
    };
  }
  
  startIdleTimer(): void {
    this.clearTimers();
    
    this.idleTimer = setTimeout(() => {
      this.logger.info('Client idle timeout reached, starting eviction process');
      this.stateMachine.transition(ServerState.EVICTING, 'idle timeout');
      
      const gracePeriod = 5000;
      this.options.onEvictionWarning(gracePeriod);
      
      this.evictionTimer = setTimeout(() => {
        this.logger.info('Eviction grace period expired, forcing cleanup');
        this.performForceCleanup();
      }, gracePeriod);
    }, this.options.idleTimeout);
    
    this.logger.debug(`Idle timer started (${this.options.idleTimeout}ms)`);
  }
  
  resetIdleTimer(): void {
    this.lastActivity = new Date().toISOString();
    
    if (this.evictionTimer) {
      this.logger.info('Activity detected during eviction, cancelling eviction');
      clearTimeout(this.evictionTimer);
      this.evictionTimer = null;
      
      if (this.stateMachine.getState() === ServerState.EVICTING) {
        this.stateMachine.transition(ServerState.ACTIVE, 'eviction cancelled');
      }
    }
    
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.startIdleTimer();
    }
  }
  
  private clearTimers(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    
    if (this.evictionTimer) {
      clearTimeout(this.evictionTimer);
      this.evictionTimer = null;
    }
  }
  
  async performCleanup(reason: string = 'unknown'): Promise<void> {
    if (this.cleanupComplete) {
      this.logger.debug('Cleanup already complete, skipping');
      return;
    }
    
    this.logger.info(`Performing cleanup (reason: ${reason})`);
    this.cleanupComplete = true;
    
    this.clearTimers();
    
    if (this.bleTransport) {
      await this.bleTransport.disconnect();
      this.bleTransport = null;
    }
    
    this.mutex.releaseConnection(this.token);
    
    if (this.wsConnection) {
      this.wsConnection.close();
      this.wsConnection = null;
    }
    
    this.logger.debug('Cleanup complete');
  }
  
  private performForceCleanup(): void {
    this.options.onForceCleanup();
    this.performCleanup('force eviction').catch(err => {
      this.logger.error('Error during force cleanup:', err);
    });
  }
  
  isOwner(token: string): boolean {
    return token === this.token;
  }
}