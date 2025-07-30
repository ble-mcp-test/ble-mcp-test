import { Logger } from './logger.js';

export class ConnectionMutex {
  private activeToken: string | null = null;
  private logger: Logger;
  
  constructor() {
    this.logger = new Logger('ConnectionMutex');
  }
  
  tryClaimConnection(token: string): boolean {
    if (this.activeToken !== null) {
      this.logger.debug(`Connection claim denied. Active token exists: ${this.activeToken}`);
      return false;
    }
    
    this.activeToken = token;
    this.logger.debug(`Connection claimed by token: ${token}`);
    return true;
  }
  
  releaseConnection(token: string): boolean {
    if (this.activeToken !== token) {
      this.logger.warn(`Cannot release connection. Token mismatch. Active: ${this.activeToken}, Provided: ${token}`);
      return false;
    }
    
    this.activeToken = null;
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
    this.logger.warn(`Force released connection. Previous token: ${previousToken}`);
  }
  
  isFree(): boolean {
    return this.activeToken === null;
  }
}