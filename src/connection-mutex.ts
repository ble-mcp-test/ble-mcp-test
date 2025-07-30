import { Logger } from './logger.js';

export class ConnectionMutex {
  private activeToken: string | null = null;
  private claimTime: number | null = null;
  private readonly MAX_CLAIM_DURATION = 30000; // 30 seconds max claim time
  private logger: Logger;
  
  constructor() {
    this.logger = new Logger('ConnectionMutex');
  }
  
  tryClaimConnection(token: string): boolean {
    // Auto-release stale claims to prevent permanent lockup
    if (this.activeToken !== null && this.claimTime !== null) {
      const claimDuration = Date.now() - this.claimTime;
      if (claimDuration > this.MAX_CLAIM_DURATION) {
        this.logger.error(`Auto-releasing stale mutex claim after ${claimDuration}ms. Token: ${this.activeToken}`);
        this.activeToken = null;
        this.claimTime = null;
      }
    }
    
    if (this.activeToken !== null) {
      this.logger.debug(`Connection claim denied. Active token exists: ${this.activeToken}`);
      return false;
    }
    
    this.activeToken = token;
    this.claimTime = Date.now();
    this.logger.debug(`Connection claimed by token: ${token}`);
    return true;
  }
  
  releaseConnection(token: string): boolean {
    if (this.activeToken !== token) {
      this.logger.warn(`Cannot release connection. Token mismatch. Active: ${this.activeToken}, Provided: ${token}`);
      return false;
    }
    
    this.activeToken = null;
    this.claimTime = null;
    this.logger.debug(`Connection released by token: ${token}`);
    return true;
  }
  
  getActiveToken(): string | null {
    return this.activeToken;
  }
  
  isOwner(token: string): boolean {
    return this.activeToken === token;
  }
  
  forceRelease(): void {
    const previousToken = this.activeToken;
    this.activeToken = null;
    this.claimTime = null;
    this.logger.warn(`Force released connection. Previous token: ${previousToken}`);
  }
  
  isFree(): boolean {
    return this.activeToken === null;
  }
}