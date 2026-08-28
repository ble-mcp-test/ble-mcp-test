import { describe, it, expect } from 'vitest';
import { canonicalUuid } from '../../src/uuid.js';

/**
 * The mock's UUID handling, held to what real Chromium actually does.
 *
 * Every expectation here was PROBED against real `navigator.bluetooth` in
 * Chromium 139 (launched with `--enable-features=WebBluetooth`, page served from
 * http://localhost so the context is secure), not read off the spec. The
 * discriminator: a rejected form throws `TypeError` at argument validation,
 * while an accepted form gets as far as `NotFoundError: Bluetooth adapter not
 * available` -- so acceptance is observable on a box with no adapter at all.
 *
 * This matters because the mock used to accept ALL of these as opaque Map keys
 * and canonicalise none of them. Four spellings of one service were four
 * distinct service objects in the mock and two in Chrome, which breaks the
 * identity clauses this suite exists to enforce.
 */
describe('canonicalUuid', () => {
  describe('forms real Chromium accepts', () => {
    it('expands a 16-bit numeric alias to the lowercase base UUID', () => {
      expect(canonicalUuid(0x9800, 'Service')).toBe('00009800-0000-1000-8000-00805f9b34fb');
    });

    it('expands a 32-bit numeric alias', () => {
      expect(canonicalUuid(0x00112233, 'Service')).toBe('00112233-0000-1000-8000-00805f9b34fb');
    });

    it('passes a full lowercase 128-bit UUID through unchanged', () => {
      const uuid = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
      expect(canonicalUuid(uuid, 'Service')).toBe(uuid);
    });

    it('maps an alias and its expanded string to the SAME canonical form', () => {
      // This is the whole point: these are one service in Chrome, and used to be
      // two in the mock.
      expect(canonicalUuid(0x9800, 'Service')).toBe(
        canonicalUuid('00009800-0000-1000-8000-00805f9b34fb', 'Service')
      );
    });
  });

  describe('forms real Chromium rejects', () => {
    it('rejects a bare 16-bit hex string', () => {
      // Probed: TypeError "Invalid Service name: '9800'". This is the form every
      // config in this repo used, and it never worked against the real API.
      expect(() => canonicalUuid('9800', 'Service')).toThrow(TypeError);
      expect(() => canonicalUuid('9800', 'Service')).toThrow(/Invalid Service name: '9800'/);
    });

    it('rejects an UPPERCASE 128-bit UUID', () => {
      // Probed: TypeError. Chrome requires lowercase hex, and the old TS bridge
      // used to accept uppercase and downcase it -- so this is a real trap.
      expect(() => canonicalUuid('00009800-0000-1000-8000-00805F9B34FB', 'Service')).toThrow(TypeError);
    });

    it('rejects a standard GATT name, and says so as a deliberate divergence', () => {
      // Chrome accepts 'heart_rate'. The mock does NOT: carrying the assigned-
      // numbers registry buys nothing for a device-agnostic tool. Documented
      // divergence, and the message has to say which way it diverges.
      expect(() => canonicalUuid('heart_rate', 'Service')).toThrow(/standard GATT names/);
    });

    it('rejects a negative or non-integer alias', () => {
      expect(() => canonicalUuid(-1, 'Service')).toThrow(TypeError);
      expect(() => canonicalUuid(1.5, 'Service')).toThrow(TypeError);
    });

    it('rejects an alias wider than 32 bits', () => {
      expect(() => canonicalUuid(0x1_0000_0000, 'Service')).toThrow(TypeError);
    });
  });

  it('names the surface in the error, so the message says which call was wrong', () => {
    expect(() => canonicalUuid('nope', 'Characteristic')).toThrow(/Invalid Characteristic name/);
  });
});
