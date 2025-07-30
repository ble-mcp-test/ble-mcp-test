import { Logger } from './logger.js';

export enum ServerState {
  IDLE = 'IDLE',
  ACTIVE = 'ACTIVE',
  EVICTING = 'EVICTING'
}

interface StateTransition {
  from: ServerState;
  to: ServerState;
  allowed: boolean;
}

export class StateMachine {
  private currentState: ServerState = ServerState.IDLE;
  private logger: Logger;
  
  private readonly validTransitions: StateTransition[] = [
    { from: ServerState.IDLE, to: ServerState.ACTIVE, allowed: true },
    { from: ServerState.ACTIVE, to: ServerState.IDLE, allowed: true },
    { from: ServerState.ACTIVE, to: ServerState.EVICTING, allowed: true },
    { from: ServerState.EVICTING, to: ServerState.IDLE, allowed: true }
  ];
  
  constructor() {
    this.logger = new Logger('StateMachine');
  }
  
  getState(): ServerState {
    return this.currentState;
  }
  
  canTransition(to: ServerState): boolean {
    return this.validTransitions.some(
      t => t.from === this.currentState && t.to === to && t.allowed
    );
  }
  
  transition(to: ServerState, context?: string): void {
    const from = this.currentState;
    
    if (!this.canTransition(to)) {
      const error = `Invalid state transition: ${from} -> ${to}`;
      this.logger.error(error);
      throw new Error(error);
    }
    
    this.currentState = to;
    this.logger.info(`State transition: ${from} -> ${to}${context ? ` (${context})` : ''}`);
  }
  
  reset(): void {
    this.logger.debug('Resetting state machine to IDLE');
    this.currentState = ServerState.IDLE;
  }
}