# The client contract

**Status:** asserted 2026-08-27. Sibling to
[`2026-08-23-ws-protocol-spec.md`](2026-08-23-ws-protocol-spec.md), which pins
bridge↔client. This pins what every *packaging* of the client must expose.

**Tracking:** TRA-1187. Related: TRA-1153 (the lifecycle realignment whose items
1–4 several clauses here make permanent), TRA-1163, TRA-1177.

---

## The claim

**There is one Web-Bluetooth-shaped client, packaged per runtime.** Not a mock
plus a Node helper — one implementation, reachable two ways. The test that
matters: *the same test should run from vitest as from Playwright*, because the
only thing that differs is packaging.

The WS protocol spec exists and is treated as the acceptance criterion for the
wire. Nothing pinned the client surface, so the two packagings drifted, no
artifact could catch it, and no test could fail. A pytest client would drift the
same way, for the same reason. This document is the missing half, and
[`tests/conformance/`](../../tests/conformance/README.md) is what holds an
implementation to it.

## The guiding principle

**Fidelity to the real Web Bluetooth API outranks everything else here.**

In production, a consumer talks to real Chrome `navigator.bluetooth`. The mock
exists only in tests. So the real API is not merely what the mock aspires to — it
is the actual runtime contract the shipped product executes against, on every
handheld, today.

Define the contract as "whatever the mock does" and it diverges from the interface
the product genuinely runs on: **a mock-authoritative contract can be fully
satisfied while the product breaks in Chrome.** That is letting a test double
define reality for the thing it doubles.

Two consequences that have teeth:

1. **Where the mock diverges from the spec, that is a mock defect, not a contract
   clause** — unless it appears in [Deliberate divergences](#deliberate-divergences)
   below, with a reason.
2. **A gap in the mock must never be frozen into the contract by deleting the
   matching surface from another packaging.**

The corollary is where the damage actually happens, so state it positively:

> **A green consumer e2e run is not evidence that the mock is faithful.** That
> inference is invalid by construction. It means "the consumer works against this
> build", never "this build is faithful to Web Bluetooth". Only the conformance
> suite can say the second, and only its arm B can say it at all.

### Under that, the mock-vs-Node tie-break

Between the mock and the Node client, **the mock wins** — from a consumer's
perspective the mock is the core use case and the Node client is the helper.
Node-only surface with no Web Bluetooth basis is presumptively cruft, **and is
deleted only after its consumers are moved, never before.**

That ordering is a constraint, not a softening. `sendCommandAsync` is Node-only,
has no Web Bluetooth basis, and has a live consumer. Deleting it before that
consumer is moved forces the move to be built against a red tree — the worst
possible condition for work whose whole point is first execution rather than
confirmation.

---

## Packaging: the axis is import vs inject

| entry | artifact | for |
|---|---|---|
| `.` | `dist/index.js`, plain ESM | anything that can `import` — vitest, Node, a bundler |
| `./browser` | `dist/web-ble-mock.bundle.js`, esbuild IIFE | Playwright `addInitScript`, vite `transformIndexHtml` |

**`./browser` vs `./node` was the wrong axis**, and naming that is worth more than
the fix. It implies two implementations of `navigator.bluetooth`, one per runtime.
There is one. `window` appears nowhere in `MockBluetooth`, `MockGATT`,
`MockService` or `MockCharacteristic` — only inside `injectWebBluetoothMock`,
whose entire job is putting the mock onto a page's navigator. The transport uses
the global `WebSocket`, native in browsers and in Node 22+; this package's floor
is Node 24.

So the only runtime-specific thing is **how the implementation reaches a global**,
and the IIFE exists because `addInitScript` and `transformIndexHtml` genuinely
cannot import. That is a real constraint, not a compatibility concession.

`.` rather than `./mock`: `./mock` names the test-double-ness. Under a fidelity
goal, what this package's default export *is* is a Web Bluetooth implementation,
and the name should say what it implements.

### One value, one source

**No member of this contract may have a different value depending on how the
package was built.** Two instances of that were live before this document:

- `_mv` had two sources — an esbuild `define` in the browser bundle, and a
  synchronous `readFileSync` of `package.json` everywhere else, selected at
  runtime by `typeof __PACKAGE_VERSION__`. The filesystem branch also put `fs` on
  the connect path of every non-bundled entry point.
- The five `BLE_MCP_MOCK_*` timing knobs were read at module scope and substituted
  by `define` for the browser. The substituted post-disconnect delay said `1100`
  while the source default said `250`, so every browser test paid 4.4× the
  measured figure while the source read 250 to anyone who checked.

Both are now single-sourced: a generated `src/version.ts`, and defaults resolved
at runtime through `globalThis.process?.env`. The rule generalises: **a build-time
substitution is a second source that agrees with the first only for as long as
somebody keeps re-checking.**

---

## The surface

### Discovery and connection

| member | guarantee |
|---|---|
| `navigator.bluetooth.requestDevice(options)` | resolves to a device with a `gatt` server. A **fresh device per call** — that is what keeps a reconnect from colliding with the previous session's objects. |
| `device.gatt.connect()` | resolves to the server; `connected` is `true` after it resolves and `false` before. |
| `device.gatt.connected` | reflects the link. |
| `device.gatt.disconnect()` | **`connected` becomes `false` synchronously**, before the returned promise settles. Callers must still `await` it: the bridge's command path is released when the *server* processes the socket close, so a fire-and-forget disconnect lets the next connect race ahead and be refused as busy by its own session. |
| `server.getPrimaryService(uuid)` | rejects when not connected; otherwise resolves, and **returns the same instance for the same UUID**. |
| `service.getCharacteristic(uuid)` | **returns the same instance for the same UUID.** |
| `navigator.bluetooth.getAvailability()` | is an adapter reachable — *not* is the reader free. A reader held by another session still reports `true`, because "someone else is using it" is a connect-time answer that names the holder. |

**Identity is per device, and the scope is load-bearing.** A consumer re-runs its
whole connect chain on reconnect. That is safe only because `requestDevice` mints
a fresh device, so the reconnect gets fresh characteristics. Hoist the cache above
the device — key it on the `MockBluetooth`, or on `serverUrl`, an easy and
superficially tidy refactor — and a reconnect gets the *same* characteristic
object back, carrying subscription state and handlers from a connection that has
ended.

**Why identity is a clause and not a nicety.** The device's characteristic map is
a fan-out *registry* keyed by UUID, not the identity cache it resembles. A second
`getCharacteristic` used to overwrite the entry, and the first reference kept its
listeners while silently receiving nothing — no error, anywhere. Identity and
delivery are two separate questions, and the delivery half is the one that reaches
a consumer as silence.

### UUIDs

**A UUID argument is canonicalised before it is used as an identity, and a
spelling the real API rejects is rejected here too.**

| form | accepted | resolves to |
|---|---|---|
| `0x9800` (number, 16- or 32-bit alias) | yes | `00009800-0000-1000-8000-00805f9b34fb` |
| `'00009800-0000-1000-8000-00805f9b34fb'` | yes | itself |
| `'9800'` | **no** — `TypeError` | — |
| `'00009800-…-00805F9B34FB'` (uppercase) | **no** — `TypeError` | — |

This is not read off the spec; it was probed against Chromium 139. A rejected
form throws `TypeError` at argument validation, while an accepted one reaches
`NotFoundError: Bluetooth adapter not available` — so acceptance is observable on
a machine with no adapter, which is how the table above was built.

Validation applies to `filters[].services`, `optionalServices`,
`getPrimaryService` and `getCharacteristic`. `optionalServices` is easy to miss
because the mock ignores it when resolving a device: an invalid entry there is
inert here and fatal in Chrome, which is precisely the asymmetry this document
exists to remove.

**Why this is an identity clause and not input hygiene.** The two accepted forms
name *one* service in Chrome and used to name *two* here, because the mock keyed
its caches on the raw argument. So every identity guarantee in the table above —
same instance per UUID, one registry entry to evict — held only for a consumer
that spelled a UUID the same way twice. Spelling it two ways silently produced
two characteristics, the second evicting the first from the device's fan-out
registry, and the first then received nothing. That is the delivery failure this
contract already calls the expensive one, reachable through a second spelling.

**The configuration object is a different surface, and stays permissive.** The
`{ service, write, notify }` passed to `injectWebBluetoothMock` is *not* Web
Bluetooth — it is this package's own config, forwarded to the bridge as
WebSocket query parameters, and the bridge normalises it in exactly one place
(`normalise_uuid` in `bridge/src/ble_bridge/esphome.py`). The mock imitates
Chrome on Chrome's surface; the bridge imitates nothing and keeps its own
tolerance. Test configuration nevertheless uses the canonical form, because the
same values are fed to `requestDevice`.

### Notifications

| member | guarantee |
|---|---|
| `characteristic.startNotifications()` | resolves to the characteristic itself, and **gates delivery**: nothing arrives before it. |
| `characteristic.stopNotifications()` | stops delivery. |
| `characteristic.writeValue(value)` | sends the bytes. Resolution does **not** currently imply an ATT acknowledgement — see [Open](#open). |
| `characteristic.addEventListener('characteristicvaluechanged', h, opts)` | see listener semantics below. |
| `device.addEventListener('gattserverdisconnected', h)` | fires on the **device**, not the server, and only on a **transport-level drop** — never on an explicit `gatt.disconnect()`. |

**The event value is a real `DataView`.** Not a duck-typed stand-in: the old shape
carried `buffer`/`byteLength`/`byteOffset`/`getUint8` and satisfied any structural
check while failing anything that called a method it had not thought to fake —
`getUint16`, `getFloat32`, or an `instanceof` test.

**It honours the byte range.** A payload that is a view into a larger buffer
delivers only the bytes sent. `new DataView(data.buffer)` alone would hand the
consumer the whole backing buffer.

### Listener semantics

- **`(type, handler)` pairs are deduplicated**, as the DOM does. This is the
  reconnect case: a consumer binds its handler once in its constructor and re-runs
  its connect chain on every reconnect, so the identical reference is registered
  again. Against a bare push, every notification is then delivered twice —
  silently, presenting as duplicated device frames, which reads as a reader or
  bridge fault rather than a listener bug.
- **`{ once: true }` is honoured**, and a handler registered alongside it is
  unaffected.
- **`removeEventListener` exists on both the characteristic and the device**, and
  removes what it names.
- **Absence, `false`, and `{ once: true }` are accepted.** Anything else throws —
  see below.

### The `testing` object

Mock-only by definition. The real API has none of this.

| member | guarantee | consumers today |
|---|---|---|
| `testing.simulateNotification({ characteristic, data, delay? })` | **the event has dispatched by the time the promise resolves.** Couples to characteristic *identity*, not UUID. Throws on an unsubscribed characteristic. | one |
| `testing.utils.toHex` / `fromHex` / `equals` | round-trip; `fromHex` accepts `"A7 0B FF"` and `"A70BFF"`. | — |
| `testing.testCommand(options)` | write, await one matching notification, resolve a result. | **none** |
| `testing.getReaderState()` | who holds the reader and since when; `null` when the bridge cannot be reached — deliberately not collapsed with a bridge reporting `held: false`. | **none** |
| `testing.setAvailability(value \| null)` | force what `getAvailability()` reports; `null` clears back to asking. | **none** |

The dispatch-before-resolve guarantee is stated here because it is **what the code
does and nothing asserted it** — a true statement with nothing keeping it true. It
survives by accident until someone adds an `await` before the dispatch, at which
point a consumer's specs fail intermittently and it reads as a mock defect rather
than as a broken guarantee. `tests/conformance` now asserts it.

---

## Deliberate divergences

The mock is **stricter** than the real API in four places. Each is a decision,
recorded here so it stays one rather than becoming folklore, and each is asserted
in arm A of the conformance suite with the real API's behaviour written beside it.

| the mock | the real API | why |
|---|---|---|
| `stopNotifications()` on a characteristic that never started **rejects**, naming the situation | Chrome resolves; the spec does not require a prior `startNotifications()` | a consumer wraps this call in an empty catch. That catch is dead while the method is a no-op; making it a real gate makes it reachable, and "already stopped" versus "transport gone" is a different debugging session for whoever unwraps it. |
| `addEventListener` **throws** on an option it does not implement — `capture`, `passive`, anything else | the DOM accepts them silently, because it implements them | a dropped option produces correct-*looking* behaviour that is wrong only later and elsewhere. This mock's own `testCommand` passed `{ once: true }` for months to a method that took no options argument at all, and so relied on a guarantee it never got. A throw is a control that can go red. |
| a standard GATT **name** (`'heart_rate'`) is **rejected** | Chrome resolves it to `0000180d-0000-1000-8000-00805f9b34fb` from the assigned-numbers registry | the devices this drives use vendor UUIDs, so the registry buys nothing, and a stale copy of it would be worse than none. The divergence is in the strict direction: nothing passes against the mock and then fails in Chrome. |
| `testing.simulateNotification` **throws** on an unsubscribed characteristic | n/a — mock-only surface | a simulated notification is an *instruction*, not a device event. The transport path swallows a frame for an unsubscribed characteristic because a radio really does that. Swallowing an explicit request would make this API a check that cannot go red: it would deliver nothing, report nothing, and the test would pass having asserted on an empty list. |

**Adding to this table is a decision, not a workaround.** A divergence that is not
here is a defect.

---

## What each conformance arm can establish

| | arm A — the mock | arm B — real Chromium |
|---|---|---|
| runs | every `just validate` | opt-in, `just conformance-real` |
| establishes | the mock satisfies the contract | the **contract itself** is faithful to the real API |
| cannot establish | anything about fidelity | anything about the wire |

Arm A runs against an in-process stub bridge, which models **no roles, no
takeover, no release timing, no error frames**. It proves the client surface and
nothing about the wire. Release timing is the most dangerous silence: it is the
property four e2e specs encoded wrong for months with nothing to contradict them.

**Arm B has never been run.** It is written; no result is recorded. See
[`tests/conformance/README.md`](../../tests/conformance/README.md) for what it
needs — including the chooser problem, which is unfinished work rather than an
unset flag.

**A skipped arm B is loud in the result line, not in the config.** A suite
reporting green with arm B silently skipped is worse than a one-armed suite,
because it looks two-armed — and the summary travels while the config does not.

---

## Open

Recorded rather than decided, because a decision needs an owner.

- **`write_ack` and what `writeValue()` resolves on.** TRA-1153 item 5b. The wire
  half has landed; which `writeValue` consumes the ack, and what its resolution
  then guarantees, is a contract change and belongs in this document when it is
  made. Note that with a contract this is "add it once, both packagings implement
  it, conformance covers both" — there is no per-client decision to make. Without
  one, that per-client decision is exactly what produced the asymmetry TRA-1187
  was filed over.
- **`testing.*` members with zero consumers.** The list is **`setAvailability`,
  `getReaderState`, and `testCommand`** — three members, and not the three the
  question was originally asked about. Two corrections, both verified against this
  tree:
  - **`forceCleanup` does not exist.** It appears in no source, test or document
    here. Whatever it once was, it is not surface this package ships, so there is
    nothing to decide about it.
  - **`testCommand` was not on the list and belongs on it.** ~40 lines of
    timeout-and-validation logic with no caller outside its own unit tests. It is
    also the method that passed `{ once: true }` to a mock that took no options
    argument for months — a guarantee it never got, from the only code that wanted
    it.

  `getReaderState` and `setAvailability` were built deliberately under TRA-35, so
  this is not a delete call. But "we ship test-only methods nobody calls" deserves
  an answer rather than inheritance, and `testCommand` has the weakest case of the
  three: it is not a capability, it is a convenience wrapper around
  `writeValue` + `addEventListener(… , { once: true })` that a consumer can write
  in five lines and tailor to its own protocol.
- **Should the client advertise itself, and where?** "Am I talking to the double or
  a real radio" is a legitimate thing for a consumer to need, and `window` is the
  wrong home for it in a runtime that may not have one. A new design question, not
  an inherited obligation. (Note: `__webBluetoothBridged` is **not** this package's
  flag — it appears nowhere in this repo or in any published bundle. A consumer
  sets it and reads it.)
- **The property matrix.** Every conformance assertion about write behaviour is
  currently an assertion about one characteristic shape, because the reference
  device physically presents only one: `0x9900` reports `properties=['write']`,
  Write-Request only, no write-without-response bit. A programmable peripheral
  would let the suite check the packagings agree *on the contract* rather than *on
  the one device we own* — and would be the first real test of the
  device-agnosticism this project claims.
