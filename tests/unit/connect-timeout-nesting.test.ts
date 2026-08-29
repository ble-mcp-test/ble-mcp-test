import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { CONNECT_BACKSTOP_MS } from '../../src/constants.js';

/**
 * The client's connect backstop must sit ABOVE the bridge's own budget.
 *
 * TRA-1189. Until 2026-08-29 it sat below: the client abandoned at a hardcoded
 * 10s while the bridge was budgeted to spend 2s on an occupancy check, then up
 * to 30s hearing the device advertise, then up to 20s on the BLE link -- 52s
 * before it could possibly answer. The outer bound was a fifth of the inner
 * one.
 *
 * The cost was not theoretical. Rep 95 of platform's soak: acquisition took
 * 9919ms, the client gave up at 10000ms, and the bridge completed the
 * connection 12ms later. A 0.12% margin, found once in 654 connects -- and the
 * distribution's max (9038ms advertisement wait) was already at 90% of the
 * deadline, so it was a deadline placed inside a population rather than outside
 * it.
 *
 * ## Why this is a test and not a comment
 *
 * The 10s was written 2025-07-20 against a local Noble radio. The 30s arrived
 * 2026-08-23 with the ESPHome transport, thirteen months later. Nobody ever
 * decided 10 < 30 -- and nobody could have noticed, because the two numbers
 * live in different languages in different directories and nothing compared
 * them. `ws-transport.ts:245-262` states the rule for the ack path ("the
 * innermost has to fire first") and the connect path violated it silently.
 *
 * A comment saying "keep these in step" is what both repos already had, in
 * three places, and it is how the drift happened. Comparison needs an owner.
 *
 * ## ⚠ The scope of a green here is narrower than the name suggests
 *
 * This proves ONE relationship: the bridge's acquisition budget is below the
 * client's backstop. It proves NOTHING about the consumer's test-hook budget,
 * which must also exceed the bridge's budget plus its own non-connect work --
 * because that term is a property of the consumer's suite and no constant in
 * this repository owns it. platform asserts that end; a green here does not
 * cover it. A check whose scope is narrower than its name converts "unknown"
 * into "verified", which is worse than no check.
 */
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const ESPHOME = 'bridge/src/ble_bridge/esphome.py';

/** Read a top-level `NAME = <float>` out of the bridge's Python. */
function seconds(source: string, name: string): number {
  const m = source.match(new RegExp(`^${name}\\s*=\\s*([0-9.]+)`, 'm'));
  // Throw rather than default. A rename upstream would otherwise make this
  // check silently compare against a budget of zero and pass forever -- the
  // over-satisfiable shape, which launders the defect into a clean baseline.
  if (!m) throw new Error(`${name} not found in ${ESPHOME}; the check cannot compare against a constant it did not find`);
  return parseFloat(m[1]);
}

describe('the connect timeouts nest, innermost first', () => {
  const source = readFileSync(projectRoot + ESPHOME, 'utf-8');

  it('the client backstop exceeds the bridge worst-case acquisition', () => {
    const allocation = seconds(source, 'ALLOCATION_REPORT_TIMEOUT_S');
    const advertisement = seconds(source, 'ADVERTISEMENT_TIMEOUT_S');
    const connect = seconds(source, 'CONNECT_TIMEOUT_S');

    // Sequential, not overlapping: esphome.py waits to hear the device
    // advertising and only then opens the link.
    const bridgeWorstCaseMs = (allocation + advertisement + connect) * 1000;

    expect(CONNECT_BACKSTOP_MS).toBeGreaterThan(bridgeWorstCaseMs);
  });

  it('leaves the bridge room to answer rather than racing it', () => {
    const bridgeWorstCaseMs =
      (seconds(source, 'ALLOCATION_REPORT_TIMEOUT_S') +
        seconds(source, 'ADVERTISEMENT_TIMEOUT_S') +
        seconds(source, 'CONNECT_TIMEOUT_S')) * 1000;

    // A backstop that merely exceeds the budget still races it: the bridge's
    // refusal and the client's giving-up would arrive together, and the caller
    // would get `TIMEOUT` instead of the typed diagnosis the bridge composed --
    // which is the thing the 10s bound was destroying. 20% is a margin, not a
    // magic number: it survives the bridge's numbers moving without demanding
    // this constant move in lockstep.
    expect(CONNECT_BACKSTOP_MS).toBeGreaterThan(bridgeWorstCaseMs * 1.2);
  });
});
