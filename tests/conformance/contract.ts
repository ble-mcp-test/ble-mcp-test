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
  /** A fresh connected chain. Called once per check, so no check inherits state. */
  open(): Promise<ConformanceSession>;
  /** Release whatever `open` produced. Must tolerate an already-closed session. */
  close(session: ConformanceSession): Promise<void>;
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
    id: 'chain/second-device-is-distinct',
    clause: 'a second requestDevice yields a distinct device with distinct characteristics',
    category: 'fidelity',
    needs: [],
    async run(session, provider) {
      // Scope, not absence: the identity cache above is per DEVICE. Hoist it and a
      // reconnect gets the previous session's characteristic objects back, still
      // carrying its subscription state and its handlers.
      const second = await provider.open();
      try {
        assert(second.device !== session.device, 'the second requestDevice returned the same device');
        assert(second.service !== session.service, 'the second device shares the first device\'s service');
        assert(
          second.notifyCharacteristic !== session.notifyCharacteristic,
          'the second device shares the first device\'s characteristic'
        );
      } finally {
        await provider.close(second);
      }
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
    id: 'notify/subscription-does-not-leak-across-devices',
    clause: 'a second device starts unsubscribed, whatever the first device did',
    category: 'fidelity',
    needs: ['injectNotification'],
    async run(session, provider) {
      // Stated observably rather than by reading a private flag, so it is a claim
      // about behaviour that arm B could also make. Hoist the identity cache
      // above the device -- an easy and superficially tidy refactor -- and a
      // reconnect gets the SAME characteristic back, carrying subscription state
      // from a connection that has ended.
      await session.notifyCharacteristic.startNotifications();

      const second = await provider.open();
      try {
        const seen: unknown[] = [];
        second.notifyCharacteristic.addEventListener(
          'characteristicvaluechanged', (e: unknown) => seen.push(e)
        );
        await provider.inject(second, [0xa7]);
        await settle();
        assertEqual(seen.length, 0, 'events delivered to a fresh device that never subscribed');
      } finally {
        await provider.close(second);
      }
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
      // On the device, not the server -- correct per Web Bluetooth, and worth
      // pinning because the obvious guess is the server. It is raised by a
      // TRANSPORT-level drop and never by an explicit gatt.disconnect(), so
      // driving it through disconnect() would produce a test that passes because
      // NOTHING fires: green for the wrong reason, unable to go red.
      let calls = 0;
      session.device.addEventListener('gattserverdisconnected', () => { calls += 1; });
      await provider.drop(session);
      await settle();
      assertEqual(calls, 1, 'gattserverdisconnected handler calls after a link drop');
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
    id: 'divergence/write-value-with-and-without-response-are-absent',
    clause:
      'writeValue() is the ONLY write method; writeValueWithResponse and ' +
      'writeValueWithoutResponse are deliberately absent, pending TRA-1153 item 5b',
    category: 'divergence',
    needs: [],
    realApiInstead:
      'Chrome has all three. writeValueWithResponse issues an ATT Write Request and ' +
      'resolves on the peer Write Response; writeValueWithoutResponse issues an ATT ' +
      'Write Command and resolves once queued. The mock has no ack to resolve on until ' +
      'TRA-1153 item 5b lands write_ack on the client side, so shipping them now means ' +
      'shipping two aliases of writeValue() -- which is what src/node/ did, stubbed and ' +
      'commented "in a real implementation, this would wait for acknowledgment". ' +
      'A method that claims to wait and does not is worse than an absent one: the ' +
      'absence is a TypeError at the call site, the alias is a guarantee that silently ' +
      'never held. THIS CHECK IS THE DEFERRAL, not the decision -- when 5b-client lands, ' +
      'delete it and add fidelity checks for all three methods.',
    async run(session) {
      // Absence asserted, not assumed. Platform's cs108-ble-transport.ts declares
      // both methods on its own hand-written interface and calls neither; that
      // declaration typechecks against a wish rather than against this object,
      // which is the defect this whole suite exists to end. If someone adds these
      // to the mock without deciding what they guarantee, this goes red.
      assertEqual(
        typeof session.writeCharacteristic.writeValue,
        'function',
        'writeValue is the one write method the mock has'
      );
      assertEqual(
        typeof session.writeCharacteristic.writeValueWithResponse,
        'undefined',
        'writeValueWithResponse is absent until write_ack gives it something to resolve on'
      );
      assertEqual(
        typeof session.writeCharacteristic.writeValueWithoutResponse,
        'undefined',
        'writeValueWithoutResponse is absent; it ships with its pair, not before it'
      );
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
