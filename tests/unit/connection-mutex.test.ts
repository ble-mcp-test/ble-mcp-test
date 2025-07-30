import { describe, it, expect, vi } from 'vitest';
import { ConnectionMutex } from '../../src/connection-mutex.js';

describe('ConnectionMutex', () => {
  it('should initialize as free', () => {
    const mutex = new ConnectionMutex();
    expect(mutex.isFree()).toBe(true);
  });

  it('should successfully claim connection when free', () => {
    const mutex = new ConnectionMutex();
    const token = 'test-token-123';
    
    const result = mutex.tryClaimConnection(token);
    expect(result).toBe(true);
    expect(mutex.isFree()).toBe(false);
  });

  it('should fail to claim connection when already claimed', () => {
    const mutex = new ConnectionMutex();
    const token1 = 'test-token-123';
    const token2 = 'test-token-456';
    
    mutex.tryClaimConnection(token1);
    const result = mutex.tryClaimConnection(token2);
    
    expect(result).toBe(false);
    expect(mutex.isFree()).toBe(false);
  });

  it('should release connection with valid token', () => {
    const mutex = new ConnectionMutex();
    const token = 'test-token-123';
    
    mutex.tryClaimConnection(token);
    expect(mutex.isFree()).toBe(false);
    
    const result = mutex.releaseConnection(token);
    expect(result).toBe(true);
    expect(mutex.isFree()).toBe(true);
  });

  it('should not release connection with invalid token', () => {
    const mutex = new ConnectionMutex();
    const token1 = 'test-token-123';
    const token2 = 'test-token-456';
    
    mutex.tryClaimConnection(token1);
    const result = mutex.releaseConnection(token2);
    
    expect(result).toBe(false);
    expect(mutex.isFree()).toBe(false);
  });

  it('should validate token ownership correctly', () => {
    const mutex = new ConnectionMutex();
    const token = 'test-token-123';
    
    // Before claiming
    expect(mutex.isOwner(token)).toBe(false);
    
    // After claiming
    mutex.tryClaimConnection(token);
    expect(mutex.isOwner(token)).toBe(true);
    expect(mutex.isOwner('wrong-token')).toBe(false);
    
    // After releasing
    mutex.releaseConnection(token);
    expect(mutex.isOwner(token)).toBe(false);
  });

  it('should handle multiple claim/release cycles', () => {
    const mutex = new ConnectionMutex();
    const token1 = 'test-token-123';
    const token2 = 'test-token-456';
    
    // First cycle
    expect(mutex.tryClaimConnection(token1)).toBe(true);
    expect(mutex.releaseConnection(token1)).toBe(true);
    
    // Second cycle with different token
    expect(mutex.tryClaimConnection(token2)).toBe(true);
    expect(mutex.releaseConnection(token2)).toBe(true);
    
    // Should be free again
    expect(mutex.isFree()).toBe(true);
  });

  it('should log debug messages when claiming and releasing', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    const mutex = new ConnectionMutex();
    const token = 'test-token-123';
    
    mutex.tryClaimConnection(token);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[ConnectionMutex]',
      'Connection claimed by token: test-token-123'
    );
    
    mutex.releaseConnection(token);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[ConnectionMutex]',
      'Connection released by token: test-token-123'
    );
    
    consoleSpy.mockRestore();
  });

  it('should be thread-safe (atomic operations)', () => {
    const mutex = new ConnectionMutex();
    const tokens = Array.from({ length: 10 }, (_, i) => `token-${i}`);
    
    // Only the first should succeed
    const results = tokens.map(token => mutex.tryClaimConnection(token));
    
    expect(results[0]).toBe(true);
    expect(results.slice(1).every(r => r === false)).toBe(true);
    expect(mutex.isOwner(tokens[0])).toBe(true);
  });
});