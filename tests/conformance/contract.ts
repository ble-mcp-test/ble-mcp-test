/**
 * The client contract, as executable checks.
 *
 * Spec: docs/design/2026-08-27-client-contract.md. That document states the
 * clauses in prose; this file is what holds an implementation to them.
 *
 * ## Why this file imports no test runner
 *
 * It runs in two places. Arm A loads it in vitest, under Node. Arm B is bundled
 * into a Chromium page by Playwright and runs against REAL
 * `navigator.bluetooth`. A check body that called `expect()` could only ever run
 * in the first. So the checks throw plain `Error`s and each runner wraps them.
 *
 * ## Why arm B is the point
 *
 * Fidelity is a comparison against the real API. A suite that can only drive the
 * mock asserts that the mock agrees with itself -- a control that cannot go red.
 * Only a tree that can put the mock and real `navigator.bluetooth` under the SAME
 * assertions can make the comparison at all, and this is that tree: platform's
 * Playwright only ever injects the mock, so it can verify "sufficient for
 * platform" and never "faithful to the spec".
 *
 * The corollary matters more, because it is where the damage happens: a green
 * platform e2e run is NOT evidence that the mock is faithful. That inference is
 * invalid by construction. Platform green means "platform works against this
 * build", never "this build is faithful to Web Bluetooth".
 *
 * ## The three categories, and why the third exists
 *
 * - `fidelity` -- must hold of the mock AND of real `navigator.bluetooth`. Run in
 *   both arms.
 * - `divergence` -- the mock is deliberately STRICTER than the real API. Run in
 *   arm A only, and each one records what the real API does instead, so the
 *   divergence stays a documented decision rather than becoming folklore.
 * - `mock-only` -- surface the real API does not have at all (`testing.*`).
 *
 * A check that cannot run in an arm is reported as NOT RUN by name. It is never
 * silently absent: a suite that looks two-armed while running one is worse than
 * an honestly one-armed suite.
 */

// --- assertions ---------------------------------------------------------------
// Deliberately tiny and deliberately not vitest's. See the header.

function fail(message: string): never {
  throw new Error(message);
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

export function assertEqual<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) {
    fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertBytes(actual: ArrayLike<number>, expected: number[], what: string): void {
  const got = Array.from(actual);
  if (got.length !== expected.length || got.some((byte, i) => byte !== expected[i])) {
    fail(`${what}: expected [${expected}], got [${got}]`);
  }
}

export async function assertRejects(
  run: () => Promise<unknown>,
  pattern: RegExp,
  what: string
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) {
      fail(`${what}: rejected, but with "${message}", which does not match ${pattern}`);
    }
    return;
  }
  fail(`${what}: resolved, but should have rejected`);
}

export function assertThrows(run: () => unknown, pattern: RegExp, what: string): void {
  try {
    run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) {
      fail(`${what}: threw "${message}", which does not match ${pattern}`);
    }
    return;
  }
  fail(`${what}: returned, but should have thrown`);
}

// --- the provider seam --------------------------------------------------------

/**
 * A connected GATT chain, reached the way a consumer reaches it.
 *
 * Every field is obtained through `requestDevice` -> `gatt.connect()` ->
 * `getPrimaryService` -> `getCharacteristic`. Nothing here is constructed by
 * hand, and nothing sets `gatt.connected` directly -- four unit files used to,
 * and that is precisely what made them un-runnable against the real API and
 * therefore unable to say anything about fidelity.
 */
export interface ConformanceSession {
  device: any;
  server: any;
  service: any;
  writeCharacteristic: any;
  notifyCharacteristic: any;
}

export interface ProviderCapabilities {
  /**
   * Can the harness make a notification arrive on demand, with bytes it chooses?
   *
   * Arm A can: the stub bridge pushes a frame. Arm B cannot -- a real peripheral
   * sends what it sends, when it sends it, and no amount of test scaffolding
   * makes a CS108 emit an arbitrary payload on cue. Checks that need it are
   * reported NOT RUN in arm B rather than quietly dropped.
   */
  injectNotification: boolean;
  /** Can the harness drop the link, to raise `gattserverdisconnected`? */
  dropLink: boolean;
  /** Is `navigator.bluetooth.testing` present? False for the real API, by definition. */
  testingApi: boolean;
  /**
   * Are this provider's configured UUIDs 16-/32-bit aliases of the Bluetooth
   * Base UUID, so a check can spell one two ways?
   *
   * Arm A picks synthetic aliasable UUIDs deliberately. Arm B cannot: it drives
   * whatever peripheral is in range, and a Nordic device's `6e400001-...` has no
   * numeric alias at all. Checks that need two spellings are reported NOT RUN by
   * name there, rather than silently degenerating into a tautology against one.
   */
  aliasableUuids: boolean;
}

export interface ConformanceProvider {
  /** Shown in the result line. e.g. "arm A (mock + stub bridge)". */
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /**
   * A connected chain, reached through `requestDevice()`.
   *
   * Called once per check, and once more inside the checks that need a second
   * `requestDevice()`. **It does not produce a fresh realm.** Both arms hold one
   * `navigator.bluetooth` for the whole run -- arm B has one page, arm A has one
   * `MockBluetooth` -- so the device object, and any listener a previous check
   * left on it, persist. That is the spec's `[[deviceInstanceMap]]`, not a leak,
   * and arm A used to mint a `MockBluetooth` per call, which made it the one
   * arm where two `requestDevice()` calls could not return the same device.
   */
  open(): Promise<ConformanceSession>;
  /** Release whatever `open` produced. Must tolerate an already-closed session. */
  close(session: ConformanceSession): Promise<void>;
  /**
   * Drop the link and bring it back up on the SAME device object, the way a
   * consumer's reconnect does.
   *
   * On the seam rather than in a check body because the retry policy belongs to
   * the transport, not to the contract. Arm B needs a settle and up to four
   * attempts -- a real CS108 has to tear the previous link down and resume
   * advertising -- and a bare `connect()` in a check body would record a radio
   * flake as a fidelity failure, which is the misattribution this suite is most
   * careful about. Nothing in the contract asserts that `connect()` succeeds
   * first time, so retrying here hides no clause.
   *
   * The session's `service` and characteristic fields are STALE afterwards, by
   * design: the point of the checks that call this is that a reconnect replaces
   * them. Re-derive from `session.server`.
   */
  reconnect(session: ConformanceSession): Promise<void>;
  /** Deliver `bytes` on the notify characteristic. Only when `injectNotification`. */
  inject(session: ConformanceSession, bytes: number[]): Promise<void>;
  /** Drop the link under the client. Only when `dropLink`. */
  drop(session: ConformanceSession): Promise<void>;
  /** The mock's `navigator.bluetooth`-level object. Only when `testingApi`. */
  bluetooth(session: ConformanceSession): any;
}

export type CheckCategory = 'fidelity' | 'divergence' | 'mock-only';

export interface ConformanceCheck {
  readonly id: string;
  /** The contract clause this check enforces, in the doc's words. */
  readonly clause: string;
  readonly category: CheckCategory;
  /** Capabilities without which this check cannot run. */
  readonly needs: ReadonlyArray<keyof ProviderCapabilities>;
  /**
   * For a `divergence`: what the REAL Web Bluetooth API does instead. Recorded
   * so the divergence is a decision on the record rather than a surprise.
   */
  readonly realApiInstead?: string;
  run(session: ConformanceSession, provider: ConformanceProvider): Promise<void>;
}

/** A short settle, for a frame that crosses a socket before it reaches a handler. */
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

function bytesOf(value: DataView): number[] {
  return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

// --- fidelity: the chain ------------------------------------------------------

const CHAIN: ConformanceCheck[] = [
  {
    id: 'chain/connected-flag',
    clause: 'gatt.connected is false before connect() and true after it resolves',
    category: 'fidelity',
    needs: [],
    async run(session) {
      assertEqual(session.server.connected, true, 'gatt.connected after connect()');
      assertEqual(session.device.gatt, session.server, 'device.gatt is the server that connected');
    }
  },
  {
    id: 'chain/service-identity',
    clause: 'getPrimaryService returns the same instance for the same UUID',
    category: 'fidelity',
    needs: [],
    async run(session) {
      const again = await session.server.getPrimaryService(session.service.uuid);
      assert(again === session.service, 'getPrimaryService returned a different instance');
    }
  },
  {
    id: 'chain/characteristic-identity',
    clause: 'getCharacteristic returns the same instance for the same UUID',
    category: 'fidelity',
    needs: [],
    async run(session) {
      // THE BUG this clause exists for: the device's characteristic registry is
      // keyed by UUID, so a second getCharacteristic used to EVICT the first --
      // the original reference kept its listeners and silently received nothing.
      const again = await session.service.getCharacteristic(session.notifyCharacteristic.uuid);
      assert(again === session.notifyCharacteristic, 'getCharacteristic returned a different instance');
    }
  },
  {
    id: 'chain/distinct-uuids-distinct-instances',
    clause: 'distinct UUIDs yield distinct characteristic instances',
    category: 'fidelity',
    needs: [],
    async run(session) {
      assert(
        session.writeCharacteristic !== session.notifyCharacteristic,
        'the write and notify characteristics are the same object'
      );
    }
  },
  {
    id: 'chain/start-notifications-returns-self',
    clause: 'startNotifications() resolves to the characteristic it was called on',
    category: 'fidelity',
    needs: [],
    async run(session) {
      const resolved = await session.notifyCharacteristic.startNotifications();
      assert(resolved === session.notifyCharacteristic, 'startNotifications() resolved to something else');
    }
  },
  {
    id: 'chain/disconnect-is-synchronous',
    clause: 'gatt.disconnect() sets connected to false before its promise settles',
    category: 'fidelity',
    needs: [],
    async run(session) {
      assertEqual(session.server.connected, true, 'precondition: connected');
      const pending = session.server.disconnect();
      // Deliberately BEFORE the await. On a real GATT server the flag flips
      // immediately; the mock used to leave it true until the socket close
      // resolved, so a consumer checking it in a teardown path saw a server that
      // was already gone reporting itself present.
      assertEqual(session.server.connected, false, 'connected immediately after calling disconnect()');
      await pending;
      assertEqual(session.server.connected, false, 'connected after disconnect() settled');
    }
  },
  {
    id: 'chain/disconnect-twice-is-safe',
    clause: 'disconnect() on an already-disconnected server resolves rather than throwing',
    category: 'fidelity',
    needs: [],
    async run(session) {
      await session.server.disconnect();
      await session.server.disconnect();
      assertEqual(session.server.connected, false, 'connected after a second disconnect()');
    }
  },
  {
    id: 'chain/second-request-returns-the-same-device',
    clause: 'a second requestDevice for the same peripheral returns the SAME device object',
    category: 'fidelity',
    needs: [],
    async run(session, provider) {
      // The spec's `[[deviceInstanceMap]]`: "get the BluetoothDevice
      // representing" is a lookup in a per-realm map keyed by the device, and it
      // mints a new object only on a miss (index.bs:2285). So one peripheral is
      // one `BluetoothDevice` for the lifetime of the page.
      //
      // THIS CHECK USED TO ASSERT THE OPPOSITE, and it is arm B's first red:
      // real Chromium returned the same device where the mock minted a fresh
      // one. The old clause conflated device identity with per-connection
      // attribute scoping -- see `chain/reconnect-replaces-attributes`, which is
      // where that intent went and where it is actually testable.
      // `second` is NOT closed here, and that is the point rather than an
      // omission: it is the same server as `session`, which the runner closes.
      const second = await provider.open();
      assert(second.device === session.device, 'the second requestDevice returned a different device');
      // The connection never dropped between the two calls, so the attribute
      // cache is still populated and the same objects come back with it.
      assert(second.service === session.service, 'the same connected device yielded a different service');
      assert(
        second.notifyCharacteristic === session.notifyCharacteristic,
        'the same connected device yielded a different characteristic'
      );
    }
  },
  {
    id: 'chain/connect-when-connected-resolves-the-same-server',
    clause: 'connect() on an already-connected server resolves with that server',
    category: 'fidelity',
    needs: [],
    async run(session) {
      // Spec step 5 of `connect()` (index.bs:3141): "If this.connected is true,
      // resolve promise with this and return promise." No second link is
      // attempted, so a consumer that calls connect() twice does not take the
      // radio twice -- against the bridge's single writer slot, a second attempt
      // would be refused as busy by the caller's own session.
      const again = await session.server.connect();
      assert(again === session.server, 'connect() on a connected server resolved with a different server');
      assertEqual(session.server.connected, true, 'connected after a second connect()');
    }
  },
  {
    id: 'chain/reconnect-replaces-attributes',
    clause: 'a disconnect clears the attribute cache: a reconnect yields new service and characteristic objects',
    category: 'fidelity',
    needs: [],
    async run(session, provider) {
      // THE SCOPE CLAUSE, in the form that is actually testable against one
      // peripheral. The identity caches asserted by `chain/service-identity` and
      // `chain/characteristic-identity` are scoped to the CONNECTION, not to the
      // page: keep them across a disconnect and a reconnect hands back the
      // previous session's objects, still carrying its subscription state and
      // its handlers -- silently, because a stale characteristic raises nothing.
      //
      // The spec spells this out as step 5 of "clean up the disconnected
      // device" (index.bs:4417): remove every entry from the
      // `[[attributeInstanceMap]]` whose key is inside the device, and null the
      // represented service and characteristic behind every object that
      // survives.
      const serviceUuid = session.service.uuid;
      const notifyUuid = session.notifyCharacteristic.uuid;

      await provider.reconnect(session);

      const service = await session.server.getPrimaryService(serviceUuid);
      const notify = await service.getCharacteristic(notifyUuid);
      assert(service !== session.service, 'the reconnect returned the previous connection\'s service');
      assert(
        notify !== session.notifyCharacteristic,
        'the reconnect returned the previous connection\'s characteristic'
      );
      // The device is the one thing that DOES survive -- the two halves of this
      // fix, asserted together so neither can be satisfied by throwing the other
      // away.
      assertEqual(service.uuid, serviceUuid, 'the reconnected service uuid');
      assertEqual(notify.uuid, notifyUuid, 'the reconnected characteristic uuid');
    }
  }
];

// --- fidelity: notification delivery ------------------------------------------

const DELIVERY: ConformanceCheck[] = [
  {
    id: 'notify/gated-before-subscribe',
    clause: 'nothing is delivered before startNotifications()',
    category: 'fidelity',
    needs: ['injectNotification'],
    async run(session, provider) {
      const seen: unknown[] = [];
      session.notifyCharacteristic.addEventListener('characteristicvaluechanged', (e: unknown) => seen.push(e));
      await provider.inject(session, [0xa7]);
      await settle();
      assertEqual(seen.length, 0, 'events delivered to an unsubscribed characteristic');
    }
  },
  {
    id: 'notify/delivered-after-subscribe',
    clause: 'a device frame reaches a registered handler once subscribed',
    category: 'fidelity',
    needs: ['injectNotification'],
    async run(session, provider) {
      const seen: number[][] = [];
      session.notifyCharacteristic.addEventListener(
        'characteristicvaluechanged',
        (event: any) => seen.push(bytesOf(event.target.value))
      );
      await session.notifyCharacteristic.startNotifications();
      await provider.inject(session, [0xa7, 0xb3]);
      await settle();
      assertEqual(seen.length, 1, 'notification count');
      assertBytes(seen[0], [0xa7, 0xb3], 'notification payload');
    }
  },
  {
    id: 'notify/value-is-a-real-dataview',
    clause: 'the event value is a real DataView, not a duck-typed stand-in',
    category: 'fidelity',
    needs: ['injectNotification'],
    async run(session, provider) {
      // `instanceof` is the assertion that matters. The old duck-typed shape
      // carried buffer/byteLength/byteOffset/getUint8 and satisfied any
      // structural check, while failing anything that called a method it had not
      // thought to fake.
      let value: any;
      session.notifyCharacteristic.addEventListener(
        'characteristicvaluechanged',
        (event: any) => { value = event.target.value; }
      );
      await session.notifyCharacteristic.startNotifications();
      await provider.inject(session, [0x12, 0x34]);
      await settle();
      assert(value instanceof DataView, `event value is ${value?.constructor?.name}, not a DataView`);
      assertEqual(value.getUint16(0), 0x1234, 'getUint16 on the delivered value');
    }
  },
  {
    id: 'notify/second-lookup-does-not-evict-the-first-reference',
    clause: 'a second getCharacteristic does not stop the first reference receiving',
    category: 'fidelity',
    needs: ['injectNotification'],
    async run(session, provider) {
      // THE bug, stated as behaviour rather than as identity. The device's
      // characteristic map is a fan-out REGISTRY keyed by UUID, not the identity
      // cache it resembles -- so a second getCharacteristic used to overwrite the
      // entry, and the first reference kept its listeners while silently
      // receiving nothing. No error, anywhere.
      const seen: number[][] = [];
      session.notifyCharacteristic.addEventListener(
        'characteristicvaluechanged',
        (event: any) => seen.push(bytesOf(event.target.value))
      );
      await session.notifyCharacteristic.startNotifications();

      await session.service.getCharacteristic(session.notifyCharacteristic.uuid);

      await provider.inject(session, [1, 2, 3]);
      await settle();
      assertEqual(seen.length, 1, 'notifications reaching the original reference');
      assertBytes(seen[0], [1, 2, 3], 'payload on the original reference');
    }
  },
  {
    id: 'notify/honours-the-byte-range-of-a-view',
    clause: 'the delivered value covers only the bytes sent, not the whole backing buffer',
    category: 'fidelity',
    needs: ['injectNotification'],
    async run(session, provider) {
      // `new DataView(data.buffer)` alone exposes the whole backing buffer, so a
      // subarray payload would deliver bytes the sender never sent.
      let value: DataView | undefined;
      session.notifyCharacteristic.addEventListener(
        'characteristicvaluechanged',
        (event: any) => { value = event.target.value; }
      );
      await session.notifyCharacteristic.startNotifications();
      await provider.inject(session, [1, 2, 3]);
      await settle();
      assert(value !== undefined, 'no notification arrived');
      assertEqual(value!.byteLength, 3, 'delivered byteLength');
      assertBytes(bytesOf(value!), [1, 2, 3], 'delivered bytes');
    }
  },
  {
    id: 'notify/subscription-does-not-survive-a-reconnect',
    clause: 'a reconnected characteristic starts unsubscribed, whatever the previous connection did',
    category: 'fidelity',
    needs: ['injectNotification'],
    async run(session, provider) {
      // The DELIVERY half of `chain/reconnect-replaces-attributes`, and the half
      // that reaches a consumer as silence rather than as a wrong object.
      // Identity and delivery are separate questions: a check that only compared
      // references would stay green against an implementation that handed back a
      // new object still wired into the old subscription.
      //
      // Stated observably rather than by reading a private flag, so it is a claim
      // arm B could make too -- it is reported NOT RUN there only because no
      // scaffolding makes a real CS108 emit a chosen payload on cue.
      //
      // This asked about a SECOND DEVICE until TRA-1255. That framing died with
      // the mock's fresh-device-per-requestDevice defect: with one peripheral
      // there is only ever one device, so the question was unaskable and the
      // check was really asserting the defect.
      await session.notifyCharacteristic.startNotifications();

      const notifyUuid = session.notifyCharacteristic.uuid;
      const serviceUuid = session.service.uuid;
      await provider.reconnect(session);

      const service = await session.server.getPrimaryService(serviceUuid);
      const notify = await service.getCharacteristic(notifyUuid);
      const seen: unknown[] = [];
      notify.addEventListener('characteristicvaluechanged', (e: unknown) => seen.push(e));
      await provider.inject(session, [0xa7]);
      await settle();
      assertEqual(seen.length, 0, 'events delivered to a reconnected characteristic that never subscribed');
    }
  },
  {
    id: 'notify/stop-notifications-gates-delivery',
    clause: 'stopNotifications() stops delivery',
    category: 'fidelity',
    needs: ['injectNotification'],
    async run(session, provider) {
      const seen: unknown[] = [];
      session.notifyCharacteristic.addEventListener('characteristicvaluechanged', (e: unknown) => seen.push(e));
      await session.notifyCharacteristic.startNotifications();
      await provider.inject(session, [0x01]);
      await settle();
      await session.notifyCharacteristic.stopNotifications();
      await provider.inject(session, [0x02]);
      await settle();
      assertEqual(seen.length, 1, 'notifications received across a stopNotifications()');
    }
  }
];

// --- fidelity: listener semantics ---------------------------------------------

const LISTENERS: ConformanceCheck[] = [
  {
    id: 'listeners/dedup-identical-pairs',
    clause: 'addEventListener drops a duplicate (type, handler) pair, as the DOM does',
    category: 'fidelity',
    needs: ['injectNotification'],
    async run(session, provider) {
      // The reconnect case. A consumer binds its handler ONCE in its constructor
      // and re-runs the whole connect chain on reconnect, so the identical
      // reference is registered again. Against a bare push, every notification is
      // then delivered twice -- presenting as duplicated device frames, which
      // reads as a reader or bridge fault rather than a listener bug.
      let calls = 0;
      const handler = () => { calls += 1; };
      session.notifyCharacteristic.addEventListener('characteristicvaluechanged', handler);
      session.notifyCharacteristic.addEventListener('characteristicvaluechanged', handler);
      session.notifyCharacteristic.addEventListener('characteristicvaluechanged', handler);
      await session.notifyCharacteristic.startNotifications();
      await provider.inject(session, [0x01]);
      await settle();
      assertEqual(calls, 1, 'calls to a handler registered three times');
    }
  },
  {
    id: 'listeners/distinct-handlers-both-fire',
    clause: 'distinct handlers are all kept -- dedup is per pair, not per type',
    category: 'fidelity',
    needs: ['injectNotification'],
    async run(session, provider) {
      let a = 0;
      let b = 0;
      session.notifyCharacteristic.addEventListener('characteristicvaluechanged', () => { a += 1; });
      session.notifyCharacteristic.addEventListener('characteristicvaluechanged', () => { b += 1; });
      await session.notifyCharacteristic.startNotifications();
      await provider.inject(session, [0x01]);
      await settle();
      assertEqual(a, 1, 'first handler calls');
      assertEqual(b, 1, 'second handler calls');
    }
  },
  {
    id: 'listeners/once-is-honoured',
    clause: '{ once: true } fires exactly once and then removes itself',
    category: 'fidelity',
    needs: ['injectNotification'],
    async run(session, provider) {
      let once = 0;
      let persistent = 0;
      session.notifyCharacteristic.addEventListener(
        'characteristicvaluechanged', () => { once += 1; }, { once: true }
      );
      session.notifyCharacteristic.addEventListener(
        'characteristicvaluechanged', () => { persistent += 1; }
      );
      await session.notifyCharacteristic.startNotifications();
      await provider.inject(session, [0x01]);
      await settle();
      await provider.inject(session, [0x02]);
      await settle();
      assertEqual(once, 1, 'a { once: true } handler fired');
      assertEqual(persistent, 2, 'the handler registered alongside it fired');
    }
  },
  {
    id: 'listeners/remove-stops-delivery',
    clause: 'removeEventListener stops delivery to the handler it names',
    category: 'fidelity',
    needs: ['injectNotification'],
    async run(session, provider) {
      let calls = 0;
      const handler = () => { calls += 1; };
      session.notifyCharacteristic.addEventListener('characteristicvaluechanged', handler);
      session.notifyCharacteristic.removeEventListener('characteristicvaluechanged', handler);
      await session.notifyCharacteristic.startNotifications();
      await provider.inject(session, [0x01]);
      await settle();
      assertEqual(calls, 0, 'calls to a removed handler');
    }
  },
  {
    id: 'listeners/device-dedups-too',
    clause: 'the device dedups (type, handler) pairs, exactly as the characteristic does',
    category: 'fidelity',
    needs: ['dropLink'],
    async run(session, provider) {
      let calls = 0;
      const handler = () => { calls += 1; };
      session.device.addEventListener('gattserverdisconnected', handler);
      session.device.addEventListener('gattserverdisconnected', handler);
      await provider.drop(session);
      await settle();
      assertEqual(calls, 1, 'calls to a disconnect handler registered twice');
    }
  },
  {
    id: 'listeners/device-disconnect-event',
    clause: 'gattserverdisconnected fires on the DEVICE when the link drops',
    category: 'fidelity',
    needs: ['dropLink'],
    async run(session, provider) {
      // On the device, not the server -- correct per Web Bluetooth, which says so
      // in as many words ("This event is not fired at the
      // BluetoothRemoteGATTServer", spec index.bs:4449), and worth pinning
      // because the obvious guess is the server.
      //
      // This is the TRANSPORT-drop limb. The explicit-disconnect limb is a
      // separate check below: the two reach the same cleanup algorithm, and this
      // one was long annotated as the only way to raise the event at all.
      let calls = 0;
      session.device.addEventListener('gattserverdisconnected', () => { calls += 1; });
      await provider.drop(session);
      await settle();
      assertEqual(calls, 1, 'gattserverdisconnected handler calls after a link drop');
    }
  },
  {
    id: 'listeners/device-disconnect-event-on-explicit-disconnect',
    clause: 'gattserverdisconnected fires on an explicit gatt.disconnect() too',
    category: 'fidelity',
    needs: [],
    async run(session) {
      // TRA-1210. The contract asserted the opposite -- "never on an explicit
      // gatt.disconnect()" -- as a statement about Chrome, with no citation and
      // no check. The normative algorithm says otherwise: disconnect()
      // (index.bs:3221) runs "clean up the disconnected device"
      // (index.bs:4417), whose last step fires the event. Both limbs converge
      // there; there is no quiet path for a page-initiated disconnect.
      //
      // No `needs`: an explicit disconnect is available in every arm by
      // definition, which is what makes this the cheapest fidelity check here
      // and makes its absence worth a comment.
      //
      // ⚠ No `settle()`, deliberately, and it is asserting the spec's TIMING as
      // well as the event: the cleanup steps run inline within `disconnect()`,
      // so a consumer that awaits the call has already been told by the time it
      // returns.
      //
      // ⚠ This check is NOT the discriminating one for the mock. Arm A runs at
      // the default `postDisconnectDelay` of 250ms, and the mock's pre-TRA-1210
      // behaviour -- fire whenever the socket close happens to round-trip --
      // satisfies it under that sleep. `tests/unit/explicit-disconnect-event.ts`
      // pins the delay to 0 and is what actually goes red. What this one is for
      // is arm B: it is the clause stated against real Chrome, which is where
      // the original claim was wrong and had never been checked at all.
      let calls = 0;
      session.device.addEventListener('gattserverdisconnected', () => { calls += 1; });
      await session.server.disconnect();
      assertEqual(calls, 1, 'gattserverdisconnected handler calls after an explicit disconnect');
    }
  },
  {
    id: 'listeners/device-disconnect-event-not-on-second-disconnect',
    clause: 'a second gatt.disconnect() on a disconnected server fires nothing',
    category: 'fidelity',
    needs: [],
    async run(session) {
      // disconnect() step 2: abort if `connected` is already false. So the event
      // is once per connection, not once per call -- the clause that stops the
      // fix above from turning into a double-fire.
      //
      // Already true of the mock before TRA-1210, so this is a regression guard
      // rather than a demonstration: it goes red if the guard inside
      // `cleanUpDisconnectedDevice` is dropped, not if it were never added.
      await session.server.disconnect();
      let calls = 0;
      session.device.addEventListener('gattserverdisconnected', () => { calls += 1; });
      await session.server.disconnect();
      await settle();
      assertEqual(calls, 0, 'gattserverdisconnected handler calls after a redundant disconnect');
    }
  },
  {
    id: 'listeners/device-remove-event-listener',
    clause: 'the device has a removeEventListener, and it works',
    category: 'fidelity',
    needs: ['dropLink'],
    async run(session, provider) {
      // addEventListener existed alone for a long time, so a registered
      // disconnect handler could not be removed by any means: a consumer that
      // attached one per connection accumulated them for the page's lifetime,
      // and each reconnect fired every handler from every prior connection.
      let calls = 0;
      const handler = () => { calls += 1; };
      session.device.addEventListener('gattserverdisconnected', handler);
      session.device.removeEventListener('gattserverdisconnected', handler);
      await provider.drop(session);
      await settle();
      assertEqual(calls, 0, 'calls to a removed disconnect handler');
    }
  }
];

// --- deliberate divergences ---------------------------------------------------

const DIVERGENCES: ConformanceCheck[] = [
  {
    id: 'divergence/stop-notifications-unsubscribed-rejects',
    clause: 'stopNotifications() on a characteristic that never started REJECTS',
    category: 'divergence',
    needs: [],
    realApiInstead:
      'Chrome resolves. The spec does not require a prior startNotifications(), ' +
      'so this is the mock being stricter on purpose.',
    async run(session) {
      // Deliberate. Platform wraps this call in an empty catch, and that catch is
      // dead while the method is a no-op; making it a real gate makes the catch
      // reachable, and "already stopped" versus "transport gone" is a different
      // debugging session for whoever eventually unwraps it.
      await assertRejects(
        () => session.notifyCharacteristic.stopNotifications(),
        /not subscribed/i,
        'stopNotifications() without startNotifications()'
      );
    }
  },
  {
    id: 'divergence/unimplemented-listener-options-throw',
    clause: 'addEventListener THROWS on an option the mock does not implement',
    category: 'divergence',
    needs: [],
    realApiInstead:
      'The DOM accepts `passive` and `capture` silently, because it implements ' +
      'both. There is no capture phase here and no passive behaviour to have.',
    async run(session) {
      // Throwing rather than ignoring is the point. A dropped option produces
      // correct-LOOKING behaviour that is wrong only later and elsewhere, which
      // is the most expensive failure class in this codebase. Its own
      // testCommand passed `{ once: true }` for months against a mock that took
      // no options argument at all, and so relied on a guarantee it never got.
      assertThrows(
        () => session.notifyCharacteristic.addEventListener(
          'characteristicvaluechanged', () => {}, { passive: true }
        ),
        /not\s+implemented/i,
        'addEventListener with { passive: true }'
      );
      assertThrows(
        () => session.notifyCharacteristic.addEventListener(
          'characteristicvaluechanged', () => {}, true
        ),
        /capture/i,
        'addEventListener with the capture flag'
      );
    }
  }
];

// --- mock-only surface --------------------------------------------------------

const TESTING_API: ConformanceCheck[] = [
  {
    id: 'testing/test-command-refuses-an-unsubscribed-characteristic',
    clause: 'testCommand() rejects when the notify characteristic never subscribed, rather than writing and timing out',
    category: 'mock-only',
    needs: ['testingApi'],
    async run(session, provider) {
      // Regression guard for a live defect (TRA-1153): testCommand registered a
      // listener and wrote WITHOUT subscribing, so item 2's delivery gate meant
      // the response was dropped and the call could only ever time out. It cost
      // a hardware-debugging session, because a timeout reads as a slow reader.
      //
      // The session's notify characteristic is unsubscribed here -- every check
      // gets a fresh session, and this one deliberately does not subscribe.
      await assertRejects(
        () => provider.bluetooth(session).testing.testCommand({
          device: session.device,
          writeCharacteristic: session.writeCharacteristic,
          notifyCharacteristic: session.notifyCharacteristic,
          command: new Uint8Array([0xa7]),
          timeout: 100
        }),
        /not subscribed/i,
        'testCommand() on a characteristic that never called startNotifications()'
      );
    }
  },
  {
    id: 'testing/simulate-dispatches-before-resolving',
    clause: 'the event has dispatched by the time simulateNotification() resolves',
    category: 'mock-only',
    needs: ['testingApi'],
    async run(session, provider) {
      // This is what the code does today and nothing asserted it, which is the
      // whole reason it is here: a true statement with nothing keeping it true.
      // It survives by accident until someone adds an `await` before the
      // dispatch, at which point platform's specs fail intermittently and it
      // reads as a mock defect rather than as a broken guarantee.
      let dispatched = false;
      session.notifyCharacteristic.addEventListener(
        'characteristicvaluechanged', () => { dispatched = true; }
      );
      await session.notifyCharacteristic.startNotifications();
      await provider.bluetooth(session).testing.simulateNotification({
        characteristic: session.notifyCharacteristic,
        data: new Uint8Array([0xa7])
      });
      assert(dispatched, 'simulateNotification() resolved before the event dispatched');
    }
  },
  {
    id: 'testing/simulate-refuses-unsubscribed',
    clause: 'simulateNotification() on an unsubscribed characteristic throws',
    category: 'mock-only',
    needs: ['testingApi'],
    async run(session, provider) {
      // A simulated notification is an INSTRUCTION, not a device event. The
      // transport path swallows a frame for an unsubscribed characteristic
      // because a radio really does that; swallowing an explicit request would
      // make this API a check that cannot go red -- delivering nothing,
      // reporting nothing, and passing on an empty list.
      await assertRejects(
        () => provider.bluetooth(session).testing.simulateNotification({
          characteristic: session.notifyCharacteristic,
          data: new Uint8Array([0xa7])
        }),
        /not subscribed/i,
        'simulateNotification() on an unsubscribed characteristic'
      );
    }
  },
  {
    id: 'testing/utils-round-trip',
    clause: 'testing.utils.toHex / fromHex / equals round-trip',
    category: 'mock-only',
    needs: ['testingApi'],
    async run(session, provider) {
      const { utils } = provider.bluetooth(session).testing;
      const bytes = new Uint8Array([0xa7, 0x0b, 0xff]);
      assertEqual(utils.toHex(bytes), 'A7 0B FF', 'toHex');
      assert(utils.equals(utils.fromHex('A7 0B FF'), bytes), 'fromHex did not round-trip');
      assert(utils.equals(utils.fromHex('A70BFF'), bytes), 'fromHex did not accept the unspaced form');
    }
  }
];

const ACCEPTED_OPTIONS: ConformanceCheck[] = [
  {
    id: 'listeners/accepts-what-it-implements',
    clause: 'absence, false, and { once: true } are all accepted without throwing',
    category: 'fidelity',
    needs: [],
    async run(session) {
      // The control for the divergence above. Without it, "throws on options" is
      // satisfiable by a method that throws on everything.
      const characteristic = session.notifyCharacteristic;
      characteristic.addEventListener('characteristicvaluechanged', () => {});
      characteristic.addEventListener('characteristicvaluechanged', () => {}, false);
      characteristic.addEventListener('characteristicvaluechanged', () => {}, { once: true });
    }
  }
];

// --- fidelity: UUID handling --------------------------------------------------
//
// Probed against Chromium 139 before these were written. The mock previously
// accepted every spelling as an opaque Map key and canonicalised none, so four
// spellings of one service were four service objects here and two in Chrome --
// which breaks the identity clauses above for any consumer that spells a UUID
// two ways. `.uuid` being canonical is the device-agnostic half; the two-
// spellings half needs an aliasable UUID and says so.

/** The canonical form: 128-bit, lowercase. Deliberately re-stated, not imported
 *  from `src/uuid.ts` -- a contract that checks an implementation using that
 *  implementation's own helper cannot catch the helper being wrong. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';

const UUIDS: ConformanceCheck[] = [
  {
    id: 'uuid/property-is-canonical',
    clause: 'characteristic.uuid and service.uuid are the full lowercase 128-bit form, whatever spelling was used to look them up',
    category: 'fidelity',
    needs: [],
    async run(session) {
      assert(
        CANONICAL_UUID.test(session.service.uuid),
        `service.uuid is not canonical 128-bit lowercase: got ${JSON.stringify(session.service.uuid)}`
      );
      assert(
        CANONICAL_UUID.test(session.notifyCharacteristic.uuid),
        `notify characteristic.uuid is not canonical 128-bit lowercase: got ${JSON.stringify(session.notifyCharacteristic.uuid)}`
      );
    }
  },
  {
    id: 'uuid/rejects-bare-16-bit-string',
    clause: "a bare '1234' is not a UUID; it is rejected with a TypeError",
    category: 'fidelity',
    needs: [],
    async run(session) {
      // Probed in Chromium 139: TypeError at argument validation, BEFORE the
      // adapter is consulted. Every config in this repo used this form.
      await assertRejects(
        () => session.service.getCharacteristic('1234'),
        /Invalid Characteristic name/i,
        "getCharacteristic('1234')"
      );
    }
  },
  {
    id: 'uuid/rejects-uppercase-128-bit',
    clause: 'an uppercase 128-bit UUID is rejected, not downcased',
    category: 'fidelity',
    needs: [],
    async run(session) {
      // The old TypeScript bridge accepted uppercase and downcased it, so this
      // is a trap with history rather than a hypothetical.
      await assertRejects(
        () => session.service.getCharacteristic('00001234-0000-1000-8000-00805F9B34FB'),
        /Invalid Characteristic name/i,
        'getCharacteristic() with uppercase hex'
      );
    }
  },
  {
    id: 'uuid/alias-and-expansion-are-one-characteristic',
    clause: 'a numeric alias and its expanded 128-bit string name the same characteristic, and return the same instance',
    category: 'fidelity',
    needs: ['aliasableUuids'],
    async run(session) {
      const canonical: string = session.notifyCharacteristic.uuid;
      assert(
        canonical.endsWith(BASE_SUFFIX),
        `check requires an aliasable UUID, got ${canonical}`
      );
      const alias = parseInt(canonical.slice(0, 8), 16);

      const viaAlias = await session.service.getCharacteristic(alias);
      const viaString = await session.service.getCharacteristic(canonical);

      // `assert`, not `assertEqual`: these are characteristic objects with a
      // parent back-reference, so the stringifying comparator reports
      // "Converting circular structure to JSON" instead of the actual defect.
      // Found by breaking the mock and reading what the check said.
      assert(
        viaAlias === viaString,
        'getCharacteristic(alias) and getCharacteristic(canonical string) returned ' +
          `different instances: ${String(viaAlias?.uuid)} vs ${String(viaString?.uuid)}`
      );
      assert(
        viaAlias === session.notifyCharacteristic,
        'getCharacteristic(alias) did not return the instance the session was opened with ' +
          `(alias -> ${String(viaAlias?.uuid)}, session -> ${String(session.notifyCharacteristic?.uuid)})`
      );
      // The non-tautological half of `uuid/property-is-canonical`: that check
      // cannot go red in an arm whose provider already hands in canonical
      // strings, but this lookup went in as a NUMBER, so a mock that keyed on
      // the raw argument fails right here.
      assert(
        CANONICAL_UUID.test(viaAlias.uuid),
        `characteristic looked up by numeric alias has non-canonical .uuid: ${JSON.stringify(viaAlias.uuid)}`
      );
    }
  },
  {
    id: 'uuid/optional-services-are-validated',
    clause: 'requestDevice validates optionalServices with the same rules as filters[].services',
    category: 'fidelity',
    needs: [],
    async run(_session, provider) {
      // Easy to miss, because the mock ignores optionalServices entirely when
      // resolving a device -- so an invalid one there is inert here and fatal in
      // Chrome. That asymmetry is exactly what this suite is for.
      const bluetooth = provider.capabilities.testingApi
        ? provider.bluetooth(_session)
        : (globalThis as any).navigator.bluetooth;
      await assertRejects(
        () => bluetooth.requestDevice({
          filters: [{ services: ['0000f00d-0000-1000-8000-00805f9b34fb'] }],
          optionalServices: ['1234']
        }),
        /Invalid Service name/i,
        "requestDevice with optionalServices: ['1234']"
      );
    }
  },
  {
    id: 'uuid/standard-gatt-names-are-not-resolved',
    clause: "a standard GATT name such as 'heart_rate' is rejected rather than resolved",
    category: 'divergence',
    needs: [],
    realApiInstead:
      "Chrome resolves 'heart_rate' to 0000180d-0000-1000-8000-00805f9b34fb via the " +
      'assigned-numbers registry. The mock carries no copy of that registry: the devices ' +
      'this drives use vendor UUIDs, and a stale table would be worse than no table. ' +
      'The divergence is in the STRICT direction, so nothing passes here and fails in Chrome.',
    async run(session) {
      await assertRejects(
        () => session.service.getCharacteristic('heart_rate'),
        /standard GATT names/i,
        "getCharacteristic('heart_rate')"
      );
    }
  },
  {
    id: 'write/write-value-resolves-on-the-acknowledgement',
    clause: 'writeValue() resolves only once the bridge has acknowledged that write',
    category: 'fidelity',
    needs: [],
    async run(session) {
      // Real writeValue maps to write-with-response, so it resolves after the
      // peer's ATT response. It used to resolve on enqueue, which made the
      // difference between "sent" and "landed" invisible to every caller.
      await session.writeCharacteristic.writeValue(new Uint8Array([0x01, 0x02]));
    }
  },
  {
    id: 'write/all-three-write-methods-exist',
    clause: 'writeValue, writeValueWithResponse and writeValueWithoutResponse all exist',
    category: 'fidelity',
    needs: [],
    async run(session) {
      // Platform's cs108-ble-transport.ts declared all three on a hand-written
      // interface while the mock had one. That declaration typechecked against a
      // wish -- the motivating example this whole suite was built around.
      for (const name of ['writeValue', 'writeValueWithResponse', 'writeValueWithoutResponse']) {
        assertEqual(typeof session.writeCharacteristic[name], 'function', `${name} exists`);
      }
    }
  },
  {
    id: 'write/without-response-does-not-wait',
    clause: 'writeValueWithoutResponse() resolves without awaiting an acknowledgement',
    category: 'fidelity',
    needs: [],
    async run(session) {
      // An ATT Write Command gets nothing back from the peer, so there is
      // nothing to await. Asserted by it resolving at all -- if it awaited an
      // ack it would still pass here, so the real force of this clause is the
      // rejection asymmetry in the two checks around it.
      await session.writeCharacteristic.writeValueWithoutResponse(new Uint8Array([0x03]));
    }
  }
];

export const CONFORMANCE_CHECKS: ReadonlyArray<ConformanceCheck> = [
  ...CHAIN,
  ...UUIDS,
  ...DELIVERY,
  ...LISTENERS,
  ...ACCEPTED_OPTIONS,
  ...DIVERGENCES,
  ...TESTING_API
];

/** The checks this provider can actually run, and the ones it cannot, by name. */
export function partitionChecks(provider: ConformanceProvider): {
  runnable: ConformanceCheck[];
  skipped: Array<{ check: ConformanceCheck; because: string }>;
} {
  const runnable: ConformanceCheck[] = [];
  const skipped: Array<{ check: ConformanceCheck; because: string }> = [];

  for (const check of CONFORMANCE_CHECKS) {
    if (check.category !== 'fidelity' && !provider.capabilities.testingApi) {
      skipped.push({
        check,
        because: check.category === 'divergence'
          ? `a deliberate divergence from the real API: ${check.realApiInstead}`
          : 'mock-only surface, absent from the real API by definition'
      });
      continue;
    }
    const missing = check.needs.filter(need => !provider.capabilities[need]);
    if (missing.length > 0) {
      skipped.push({ check, because: `provider cannot ${missing.join(' or ')}` });
      continue;
    }
    runnable.push(check);
  }

  return { runnable, skipped };
}
