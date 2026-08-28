import { describe, it, expect } from 'vitest';
import {
  TEST_COMMAND_BYTES,
  TEST_RESPONSE_VALIDATION,
  isValidTestResponse
} from '../shared/device-commands.js';

/**
 * GET_TRIGGER_STATE (0xA001) round-trip validation.
 *
 * The response's byte 10 is the TRIGGER STATE, and 0x00 (released) and 0x01
 * (pressed) are BOTH valid device states. This suite froze 0x00 into the
 * validity condition from the file's first commit, which means a run with
 * someone's finger on the trigger reports "Invalid response format" while the
 * device behaved perfectly -- a hardware-looking failure with a software cause.
 *
 * `trakrf/platform` has had this right the whole time, in
 * frontend/tests/config/cs108.config.ts: "Deterministic response: 0x00
 * (released) or 0x01 (pressed)". Platform is authoritative for CS108 semantics.
 */
describe('GET_TRIGGER_STATE response validation', () => {
  // Captured from the live CS108 via the ESPHome proxy, 2026-08-27.
  const RELEASED = new Uint8Array([0xA7, 0xB3, 0x03, 0xD9, 0x82, 0x9E, 0x74, 0x37, 0xA0, 0x01, 0x00]);
  const PRESSED = new Uint8Array([0xA7, 0xB3, 0x03, 0xD9, 0x82, 0x9E, 0x74, 0x37, 0xA0, 0x01, 0x01]);

  it('accepts a released-trigger response', () => {
    expect(isValidTestResponse(RELEASED)).toBe(true);
  });

  it('accepts a PRESSED-trigger response, which is equally valid', () => {
    // The regression this file exists for. Holding the trigger during a run is
    // not a malformed response.
    expect(isValidTestResponse(PRESSED)).toBe(true);
  });

  it('rejects an out-of-range trigger state', () => {
    const bogus = new Uint8Array(RELEASED);
    bogus[10] = 0x07;
    expect(isValidTestResponse(bogus)).toBe(false);
  });

  it('rejects a wrong command echo', () => {
    const bogus = new Uint8Array(RELEASED);
    bogus[9] = 0x02;
    expect(isValidTestResponse(bogus)).toBe(false);
  });

  it('rejects a short frame', () => {
    expect(isValidTestResponse(RELEASED.slice(0, 10))).toBe(false);
  });

  it('names both valid trigger states in the constant, so consumers need no second copy', () => {
    expect([...TEST_RESPONSE_VALIDATION.triggerState.valid]).toEqual([0x00, 0x01]);
    expect(TEST_RESPONSE_VALIDATION.triggerState.index).toBe(10);
  });

  it('queries the trigger state, matching the echo it validates', () => {
    expect(TEST_COMMAND_BYTES[8]).toBe(0xA0);
    expect(TEST_COMMAND_BYTES[9]).toBe(0x01);
  });
});
