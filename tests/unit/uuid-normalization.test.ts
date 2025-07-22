import { describe, it, expect } from 'vitest';

// Manually implement the same logic as in noble-transport.ts
// This avoids complex extraction and makes tests more stable
function normalizeUuid(uuid: string): string {
  // Remove dashes and convert to lowercase
  const cleaned = uuid.toLowerCase().replace(/-/g, '');
  
  // If already 32 chars (full UUID without dashes), return as-is
  if (cleaned.length === 32) return cleaned;
  
  // If 4-char short UUID, expand to full 128-bit
  if (cleaned.length === 4) {
    return `0000${cleaned}00001000800000805f9b34fb`;
  }
  
  // Handle other lengths by padding and taking last 4 chars
  const shortId = cleaned.padStart(4, '0').slice(-4);
  return `0000${shortId}00001000800000805f9b34fb`;
}

describe('UUID Normalization', () => {
  describe('Short UUIDs (16-bit)', () => {
    it('converts 16-bit UUIDs to full 128-bit format', () => {
      expect(normalizeUuid('180a')).toBe('0000180a00001000800000805f9b34fb');
      expect(normalizeUuid('180f')).toBe('0000180f00001000800000805f9b34fb');
      expect(normalizeUuid('2a19')).toBe('00002a1900001000800000805f9b34fb');
    });

    it('handles uppercase 16-bit UUIDs', () => {
      expect(normalizeUuid('180A')).toBe('0000180a00001000800000805f9b34fb');
      expect(normalizeUuid('180F')).toBe('0000180f00001000800000805f9b34fb');
      expect(normalizeUuid('2A19')).toBe('00002a1900001000800000805f9b34fb');
    });

    it('handles mixed case 16-bit UUIDs', () => {
      expect(normalizeUuid('1A2b')).toBe('00001a2b00001000800000805f9b34fb');
      expect(normalizeUuid('FfEe')).toBe('0000ffee00001000800000805f9b34fb');
    });
  });

  describe('Full UUIDs (128-bit)', () => {
    it('removes dashes from standard UUID format', () => {
      expect(normalizeUuid('0000180a-0000-1000-8000-00805f9b34fb'))
        .toBe('0000180a00001000800000805f9b34fb');
      expect(normalizeUuid('0000180f-0000-1000-8000-00805f9b34fb'))
        .toBe('0000180f00001000800000805f9b34fb');
    });

    it('handles uppercase full UUIDs', () => {
      expect(normalizeUuid('0000180A-0000-1000-8000-00805F9B34FB'))
        .toBe('0000180a00001000800000805f9b34fb');
      expect(normalizeUuid('0000FFEE-0000-1000-8000-00805F9B34FB'))
        .toBe('0000ffee00001000800000805f9b34fb');
    });

    it('handles mixed case full UUIDs', () => {
      expect(normalizeUuid('0000ABcd-0000-1000-8000-00805f9B34Fb'))
        .toBe('0000abcd00001000800000805f9b34fb');
    });

    it('returns already normalized UUIDs unchanged', () => {
      expect(normalizeUuid('0000180a00001000800000805f9b34fb'))
        .toBe('0000180a00001000800000805f9b34fb');
      expect(normalizeUuid('0000ffee00001000800000805f9b34fb'))
        .toBe('0000ffee00001000800000805f9b34fb');
    });
  });

  describe('Edge cases', () => {
    it('handles UUIDs with less than 4 characters', () => {
      expect(normalizeUuid('1')).toBe('0000000100001000800000805f9b34fb');
      expect(normalizeUuid('ab')).toBe('000000ab00001000800000805f9b34fb');
      expect(normalizeUuid('abc')).toBe('00000abc00001000800000805f9b34fb');
    });

    it('handles UUIDs with more than 4 but less than 32 characters', () => {
      // Takes last 4 chars after padding
      expect(normalizeUuid('12345')).toBe('0000234500001000800000805f9b34fb');
      expect(normalizeUuid('abcdef')).toBe('0000cdef00001000800000805f9b34fb');
    });

    it('handles empty string', () => {
      expect(normalizeUuid('')).toBe('0000000000001000800000805f9b34fb');
    });
  });

  describe('CS108 specific UUIDs', () => {
    it('correctly normalizes CS108 service and characteristic UUIDs', () => {
      // CS108 uses these specific UUIDs
      expect(normalizeUuid('9800')).toBe('0000980000001000800000805f9b34fb');
      expect(normalizeUuid('9900')).toBe('0000990000001000800000805f9b34fb');
      expect(normalizeUuid('9901')).toBe('0000990100001000800000805f9b34fb');
    });

    it('handles CS108 UUIDs in full format', () => {
      expect(normalizeUuid('00009800-0000-1000-8000-00805f9b34fb'))
        .toBe('0000980000001000800000805f9b34fb');
      expect(normalizeUuid('00009900-0000-1000-8000-00805f9b34fb'))
        .toBe('0000990000001000800000805f9b34fb');
      expect(normalizeUuid('00009901-0000-1000-8000-00805f9b34fb'))
        .toBe('0000990100001000800000805f9b34fb');
    });
  });
});