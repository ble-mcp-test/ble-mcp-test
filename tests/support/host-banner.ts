/**
 * vitest's globalSetup: print what this host could not run.
 *
 * The skip must be LOUD, and that is the whole reason this file exists rather
 * than a comment in a config. A gate that goes green on a host which ran half of
 * it is worse than the honest red it replaced -- CLAUDE.md's second failure
 * class, a silent fallback that looks like configuration. What makes the arm-B
 * version safe is that the count and the names travel in the printed result, so
 * this does the same for the host.
 *
 * It prints on the way IN and on the way OUT. In, because a run that dies
 * half-way still has to say what it was going to skip; out, because that is
 * where the summary line a reader actually reads ends up.
 */
import { renderHostGateReport } from './host-gate.js';

export function setup(): void {
  console.log(renderHostGateReport());
}

export function teardown(): void {
  console.log(renderHostGateReport());
}
