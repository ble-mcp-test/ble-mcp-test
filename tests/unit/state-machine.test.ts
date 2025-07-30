import { describe, it, expect, vi } from 'vitest';
import { StateMachine, ServerState } from '../../src/state-machine.js';

describe('StateMachine', () => {
  it('should initialize with IDLE state', () => {
    const sm = new StateMachine();
    expect(sm.getState()).toBe(ServerState.IDLE);
  });

  it('should transition from IDLE to ACTIVE', () => {
    const sm = new StateMachine();
    sm.transition(ServerState.ACTIVE, 'test connection');
    
    expect(sm.getState()).toBe(ServerState.ACTIVE);
  });

  it('should transition from ACTIVE to EVICTING', () => {
    const sm = new StateMachine();
    sm.transition(ServerState.ACTIVE, 'test connection');
    
    sm.transition(ServerState.EVICTING, 'idle timeout');
    expect(sm.getState()).toBe(ServerState.EVICTING);
  });

  it('should transition from EVICTING to IDLE', () => {
    const sm = new StateMachine();
    sm.transition(ServerState.ACTIVE, 'test connection');
    sm.transition(ServerState.EVICTING, 'idle timeout');
    
    sm.transition(ServerState.IDLE, 'cleanup complete');
    expect(sm.getState()).toBe(ServerState.IDLE);
  });

  it('should not allow invalid transition from IDLE to EVICTING', () => {
    const sm = new StateMachine();
    
    expect(() => sm.transition(ServerState.EVICTING, 'invalid')).toThrow('Invalid state transition: IDLE -> EVICTING');
    expect(sm.getState()).toBe(ServerState.IDLE);
  });

  it('should not allow invalid transition from EVICTING to ACTIVE', () => {
    const sm = new StateMachine();
    sm.transition(ServerState.ACTIVE, 'test connection');
    sm.transition(ServerState.EVICTING, 'idle timeout');
    
    expect(() => sm.transition(ServerState.ACTIVE, 'invalid')).toThrow('Invalid state transition: EVICTING -> ACTIVE');
    expect(sm.getState()).toBe(ServerState.EVICTING);
  });

  it('should handle ACTIVE to IDLE transition for error cases', () => {
    const sm = new StateMachine();
    sm.transition(ServerState.ACTIVE, 'test connection');
    
    sm.transition(ServerState.IDLE, 'connection error');
    expect(sm.getState()).toBe(ServerState.IDLE);
  });

  it('should log transitions', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    const sm = new StateMachine();
    sm.transition(ServerState.ACTIVE, 'test connection');
    
    expect(consoleSpy).toHaveBeenCalledWith(
      '[StateMachine]',
      'State transition: IDLE -> ACTIVE (test connection)'
    );
    
    consoleSpy.mockRestore();
  });

  it('should check if transition is allowed', () => {
    const sm = new StateMachine();
    
    // From IDLE
    expect(sm.canTransition(ServerState.ACTIVE)).toBe(true);
    expect(sm.canTransition(ServerState.EVICTING)).toBe(false);
    expect(sm.canTransition(ServerState.IDLE)).toBe(false); // IDLE to IDLE not defined
    
    // From ACTIVE
    sm.transition(ServerState.ACTIVE, 'test');
    expect(sm.canTransition(ServerState.IDLE)).toBe(true);
    expect(sm.canTransition(ServerState.EVICTING)).toBe(true);
    expect(sm.canTransition(ServerState.ACTIVE)).toBe(false); // ACTIVE to ACTIVE not defined
    
    // From EVICTING
    sm.transition(ServerState.EVICTING, 'test');
    expect(sm.canTransition(ServerState.IDLE)).toBe(true);
    expect(sm.canTransition(ServerState.ACTIVE)).toBe(false);
    expect(sm.canTransition(ServerState.EVICTING)).toBe(false); // EVICTING to EVICTING not defined
  });
});