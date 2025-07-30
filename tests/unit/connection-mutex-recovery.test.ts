import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionMutex } from '../../src/connection-mutex.js';

describe('ConnectionMutex Recovery', () => {
  let mutex: ConnectionMutex;

  beforeEach(() => {
    mutex = new ConnectionMutex();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should auto-release stale mutex claims after 30 seconds', () => {
    const token1 = 'stale-token';
    const token2 = 'new-token';
    
    // First connection claims mutex
    expect(mutex.tryClaimConnection(token1)).toBe(true);
    
    // Second connection cannot claim
    expect(mutex.tryClaimConnection(token2)).toBe(false);
    
    // Advance time by 29 seconds - still locked
    vi.advanceTimersByTime(29000);
    expect(mutex.tryClaimConnection(token2)).toBe(false);
    
    // Advance past 30 seconds - should auto-release
    vi.advanceTimersByTime(2000);
    expect(mutex.tryClaimConnection(token2)).toBe(true);
  });

  it('should not auto-release if claim is refreshed', () => {
    const token1 = 'active-token';
    const token2 = 'waiting-token';
    
    // First connection claims mutex
    expect(mutex.tryClaimConnection(token1)).toBe(true);
    
    // Release and reclaim (simulating activity)
    vi.advanceTimersByTime(25000);
    expect(mutex.releaseConnection(token1)).toBe(true);
    expect(mutex.tryClaimConnection(token1)).toBe(true);
    
    // Even after total of 31 seconds, the refreshed claim is still valid
    vi.advanceTimersByTime(6000);
    expect(mutex.tryClaimConnection(token2)).toBe(false);
  });

  it('should handle rapid claim/release cycles', () => {
    const tokens = Array.from({ length: 10 }, (_, i) => `token-${i}`);
    
    tokens.forEach((token, index) => {
      expect(mutex.tryClaimConnection(token)).toBe(true);
      vi.advanceTimersByTime(100);
      expect(mutex.releaseConnection(token)).toBe(true);
    });
    
    // All tokens were properly released
    expect(mutex.isFree()).toBe(true);
  });

  it('should properly track claim time on force release', () => {
    const token1 = 'forced-token';
    const token2 = 'next-token';
    
    expect(mutex.tryClaimConnection(token1)).toBe(true);
    
    // Force release
    mutex.forceRelease();
    
    // New token can claim immediately
    expect(mutex.tryClaimConnection(token2)).toBe(true);
    
    // And the new claim should have its own timeout
    vi.advanceTimersByTime(31000);
    expect(mutex.tryClaimConnection('token3')).toBe(true);
  });
});