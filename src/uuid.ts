/**
 * UUID canonicalisation, matching what real Chromium `navigator.bluetooth` does.
 *
 * The mock used to treat a UUID as an opaque Map key: it accepted every spelling
 * and canonicalised none. Real Chrome accepts exactly two forms and maps both to
 * one canonical string, so `0x9800` and `'00009800-0000-1000-8000-00805f9b34fb'`
 * name ONE service there and named two here. That silently broke the identity
 * clauses in the client contract -- `getCharacteristic` returning a stable
 * instance per UUID -- for any consumer that spelled a UUID two ways.
 *
 * Probed against Chromium 139, not read off the spec. A form Chrome rejects
 * throws `TypeError` at argument validation; a form it accepts reaches
 * `NotFoundError: Bluetooth adapter not available`. That discriminator makes
 * acceptance observable on a machine with no Bluetooth adapter at all.
 *
 * ## The one deliberate divergence
 *
 * Chrome also resolves standard GATT names (`'heart_rate'`). This mock does not.
 * Carrying the assigned-numbers registry buys nothing for a device-agnostic
 * tool -- the devices this drives use vendor UUIDs -- and a stale copy of that
 * table would be worse than no table. The mock is STRICTER here, never more
 * permissive, so nothing passes conformance against the mock and then fails
 * against Chrome. Recorded in the contract doc and pinned by a `divergence`
 * check.
 */

/** Chrome requires lowercase hex. Uppercase is rejected, not downcased. */
const UUID_128 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The Bluetooth Base UUID suffix that a 16- or 32-bit alias expands against. */
const BASE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';

export type UuidSurface = 'Service' | 'Characteristic' | 'Descriptor';

/**
 * Resolve `value` to the canonical 128-bit lowercase form, or throw `TypeError`
 * exactly where real Chromium throws it.
 */
export function canonicalUuid(value: string | number, surface: UuidSurface): string {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new TypeError(
        `Invalid ${surface} name: ${value}. A numeric UUID alias must be a 16- or ` +
          `32-bit unsigned integer, e.g. 0x1234.`
      );
    }
    return value.toString(16).padStart(8, '0') + BASE_UUID_SUFFIX;
  }

  if (UUID_128.test(value)) return value;

  throw new TypeError(
    `Invalid ${surface} name: '${value}'. It must be a numeric UUID alias ` +
      `(e.g. 0x1234) or a full lowercase 128-bit UUID ` +
      `(e.g. '00001234${BASE_UUID_SUFFIX}'). Note that uppercase hex is rejected, ` +
      `as it is by real Web Bluetooth, and that standard GATT names such as ` +
      `'heart_rate' are NOT resolved by this mock -- a deliberate divergence in ` +
      `the strict direction, recorded in docs/design/2026-08-27-client-contract.md.`
  );
}

/** True when `uuid` is the expansion of a 16- or 32-bit alias. */
export function aliasOf(uuid: string): number | null {
  if (!UUID_128.test(uuid) || !uuid.endsWith(BASE_UUID_SUFFIX)) return null;
  return parseInt(uuid.slice(0, 8), 16);
}
