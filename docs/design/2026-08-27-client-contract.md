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

### Under that, the mock-vs-Node tie-break — RESOLVED in 0.9.0

Between the mock and the Node client, **the mock wins** — from a consumer's
perspective the mock is the core use case and the Node client is the helper.
Node-only surface with no Web Bluetooth basis is presumptively cruft, **and is
deleted only after its consumers are moved, never before.**

That ordering was a constraint, not a softening, and it was honoured. `trakrf/platform`
PR #596 (`3885cf7f`, 2026-08-28) moved their integration suite onto the Web
Bluetooth surface first; `src/node/` and the `./node` subpath were deleted after,
in 0.9.0. There is now one implementation and no tie-break left to apply — the
rule is kept here because it is the rule that produced the outcome, and because
the next Node-only convenience will want the same test applied to it.

**`sendCommandAsync` is the one member that needed a judgement rather than a
rule, and the answer was neither promote nor delete.** It correlated a write with
the next inbound frame — real behaviour, unlike the rest of the flat API. It is
still not contract surface: correlation is not a Web Bluetooth concept, because
real GATT gives you a write and a notification stream with nothing joining them,
and any correlation is the device protocol's business. Promoting it would oblige
every future packaging — pytest included — to reimplement a device-shaped idea
the API it doubles does not have, which also cuts against TRA-1188. It moved into
the consumer's own test tooling instead, as platform's `TransportCommandClient`,
driven over the transport's `MessagePort`.

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
| `characteristic.writeValue(value)` | see [Writes](#writes) — it resolves on the bridge's acknowledgement of that write, and rejects when the write failed. |
| `characteristic.addEventListener('characteristicvaluechanged', h, opts)` | see listener semantics below. |
| `device.addEventListener('gattserverdisconnected', h)` | fires on the **device**, not the server, and only on a **transport-level drop** — never on an explicit `gatt.disconnect()`. |

| `characteristic.dispatchEvent(event)` | the **public** notification-injection point, matching the real API's `EventTarget`. `testing.simulateNotification` goes through it rather than around it, so anything asserted about one holds for the other. |

**The event value is a real `DataView`.** Not a duck-typed stand-in: the old shape
carried `buffer`/`byteLength`/`byteOffset`/`getUint8` and satisfied any structural
check while failing anything that called a method it had not thought to fake —
`getUint16`, `getFloat32`, or an `instanceof` test.

**It honours the byte range.** A payload that is a view into a larger buffer
delivers only the bytes sent. `new DataView(data.buffer)` alone would hand the
consumer the whole backing buffer.

### Writes

Three methods, and the difference between them is a real guarantee rather than a
naming convention.

| member | resolves when | rejects when |
|---|---|---|
| `writeValue(data)` | the bridge acknowledges **that** write | `write_ack{ok:false}`, or no ack inside the timeout |
| `writeValueWithResponse(data)` | same, **and** the ack reports `mode: 'with-response'` | as above, or the write went out `without-response` |
| `writeValueWithoutResponse(data)` | the frame is handed to the transport | the transport is not connected |

**`writeValue()` resolving on the acknowledgement is the clause that matters.**
It used to resolve on enqueue and never reject, which made every consumer's
write-failure path unreachable code — a retry branch that could not run and a
`catch` that could not fire. Correlation is by `write_id`, minted per write and
echoed by the bridge; positional correlation was rejected because a dropped ack
would silently shift every later write onto the wrong promise.

**`writeValueWithResponse` rejecting on a `without-response` ack** is what stops
the pair being two names for one behaviour. The bridge's write mode is a runtime
knob, so configuration cannot answer it and only the `mode` on each ack can. On a
device whose write characteristic advertises `properties=['write']` — the CS108 —
that rejection should never fire, which makes it a detector for a bridge
misconfiguration that would otherwise be silent.

**The gate is real, not documentary.** `writeValueWithoutResponse` rejects on a
characteristic that does not advertise the property, matching Chrome's
`NotSupportedError`. The bridge puts `write_properties` on the `connected` frame,
so the mock can see what the peripheral actually supports — on the CS108 that is
`['write']`, which makes the call illegal there and the mock says so.

**Absent is not empty.** A bridge that cannot report properties omits the field,
and the client then does not gate. Sending `[]` would mean "supports nothing" and
turn a missing capability into a hard failure on every write, which is worse than
the looseness it replaced.

#### What a write rejection IS — a code, never a sentence

Every rejection from a write path is a **`WriteError`**, exported from the
package entry point along with `WRITE_ERROR_CODES`. It carries:

| member | |
|---|---|
| `name` | `'WriteError'` |
| `code` | one of `ACK_TIMEOUT`, `WRITE_REJECTED`, `LINK_LOST`, `NOT_CONNECTED` |
| `mayHaveReachedDevice` | whether the write may already be at the device |

**A consumer decides about retrying by reading `mayHaveReachedDevice`, not by
enumerating codes.** An allowlist of codes is a copy of this package's vocabulary
living in the consumer's repository, and it silently misclassifies the next code
added here. The property is a fact about the failure, so it cannot go stale; this
package owns keeping it correct for every code it ever adds.

**The reason it exists at all, which outlives the mechanism:** an `ACK_TIMEOUT`
means only that no acknowledgement came back inside the cap. **The write may
already have reached the device, so this rejection must never be matchable by a
retry predicate** — the retry would be a second write, and for a stateful device
protocol a duplicate command is not the same thing as a lost one.

**⚠ `mayHaveReachedDevice: false` is NECESSARY for a retry, not SUFFICIENT.** It
answers exactly one question — *can this retry duplicate a write?* — and a
consumer that reads it as *is this worth retrying?* will get a different question's
answer. `LINK_LOST` and `NOT_CONNECTED` are both non-duplicative and both
pointless to retry: there is no link to retry onto. Worse than pointless, in fact
— platform's `cs108-ble-transport` records the harm from TRA-1179: if the link
*does* come back, a retry lands a **stale command on a fresh connection**, which
is the most damaging outcome available on this path.

So the retry rule a consumer wants is this property **and** a local fact about
its own link:

    retry  <=  !err.mayHaveReachedDevice  AND  the link is still up

which leaves `WRITE_REJECTED` as the one code this package can promise is worth
retrying. That is still not an allowlist — a code added here slots in on the
property with no consumer change — but the sufficiency lives on the consumer's
side and this package must not claim it.

The message text is human prose and is **free to be reworded**. That freedom is
the point of the code.

**Discriminate by `name`, never `instanceof`.** `err.name === 'WriteError'` is the
check. `instanceof` is **not safe against this package**: the same consumer can
receive errors from two module instances — the `.` entry point and the injected
`./browser` bundle — and class identity is scoped to whichever one defined the
class. A structurally correct `WriteError` from the other copy fails `instanceof`
while being, in every way that matters, the same error.

**`LINK_LOST` arrives AFTER `gatt.connected` is already false.** A consumer may
read the link state at the moment it catches the error and get an answer
consistent with the error it is holding.

The mechanism is worth stating, because the obvious reading of it is wrong. It
does **not** rest on the order of the two statements in the close handler:
`reject()` schedules a microtask, the handler's remaining synchronous work —
including the flag flip — runs to completion first, and the consumer's `catch`
therefore runs after it **in either source order**. What the guarantee actually
rests on is that **the flip is synchronous with the close handler**. Defer it by
a macrotask and the guarantee breaks.

> **Recorded because both this package and its consumer got it wrong the same
> way.** Each of us read execution order off a source listing and concluded the
> statement order was load-bearing — one arguing it was a live defect, the other
> that it was an accident waiting to happen. It was neither: the two orders are
> observationally identical, proven by running the test against both. **Source
> order and observation order are different questions across an async boundary,
> and reading one for the other has no tell** — the code looks exactly like what
> you expect it to do. The lesson that survives: pin the property by execution,
> and do not let a plausible mechanism stand in for one you measured.

> **What this replaced, recorded because the shape recurs.** Until 0.10.0 these
> were bare `Error`s, so the only available discriminator was the message text —
> and platform's transport matched `'Device busy'` / `'GATT operation already in
> progress'` as substrings to decide whether to retry. That made an unreferenced
> string literal in `ws-transport.ts` load-bearing across two repositories:
> rewording it to contain "busy" would have made the timeout retryable and run
> their retry loop past the command timeout that owns it, **with nothing in this
> repository going red.** The only guard was a test in the consumer's repo, which
> is the one place a change here cannot be seen. A code is an interface; prose is
> not, however carefully worded.

#### The ack cap is one end of a window, not a safety margin

The `writeValue` ack timeout defaults to **1500ms**, and it is not tunable for
comfort in either direction:

- **Raising it** re-opens the failure it was lowered to close — the rejection
  arrives after the consumer's command timeout has already rejected, which
  manufactures orphaned rejections rather than merely losing a retry. It has to
  stay inside platform's 2000ms write budget and 2500ms command timeout.
- **Lowering it** is not simply tighter. The cap is the **right-hand edge of a
  live window** in the consumer's retry arithmetic (their second window ends
  exactly at the cap). Dropping it shortens that window from the far end, and far
  enough down it closes entirely.

Neither side can price a move to it alone: this package cannot see the consumer's
windows, and the consumer cannot see what the cap costs the ack path. **Any change
to it is a joint decision with both on the table.**

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

### Lifecycle, mock-only

| member | guarantee |
|---|---|
| `bluetooth.teardown()` | releases the transport and resolves even if nothing was connected. Tolerates an already-closed session, because a teardown that throws on a failed setup masks the failure it was meant to clean up after. Not a Web Bluetooth member — real `navigator.bluetooth` has no lifecycle to unwind. |

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

The mock is **stricter** than the real API in five places. Each is a decision,
recorded here so it stays one rather than becoming folklore, and each is asserted
in arm A of the conformance suite with the real API's behaviour written beside it.

| the mock | the real API | why |
|---|---|---|
| `stopNotifications()` on a characteristic that never started **rejects**, naming the situation | Chrome resolves; the spec does not require a prior `startNotifications()` | a consumer wraps this call in an empty catch. That catch is dead while the method is a no-op; making it a real gate makes it reachable, and "already stopped" versus "transport gone" is a different debugging session for whoever unwraps it. |
| `addEventListener` **throws** on an option it does not implement — `capture`, `passive`, anything else | the DOM accepts them silently, because it implements them | a dropped option produces correct-*looking* behaviour that is wrong only later and elsewhere. This mock's own `testCommand` passed `{ once: true }` for months to a method that took no options argument at all, and so relied on a guarantee it never got. A throw is a control that can go red. |
| a standard GATT **name** (`'heart_rate'`) is **rejected** | Chrome resolves it to `0000180d-0000-1000-8000-00805f9b34fb` from the assigned-numbers registry | the devices this drives use vendor UUIDs, so the registry buys nothing, and a stale copy of it would be worse than none. The divergence is in the strict direction: nothing passes against the mock and then fails in Chrome. |
| `testing.testCommand` **rejects** on an unsubscribed notify characteristic | n/a — mock-only surface | the wait can never be satisfied, so the alternative is writing to the device and then timing out. A command whose response is guaranteed to be dropped is a broken call, not a slow one, and reporting it as a timeout is this codebase's most expensive failure mode. Refusing rather than subscribing on the caller's behalf keeps subscription the caller's decision, and avoids leaving their characteristic subscribed without them asking. |
| `testing.simulateNotification` **throws** on an unsubscribed characteristic | n/a — mock-only surface | a simulated notification is an *instruction*, not a device event. The transport path swallows a frame for an unsubscribed characteristic because a radio really does that. Swallowing an explicit request would make this API a check that cannot go red: it would deliver nothing, report nothing, and the test would pass having asserted on an empty list. |

**Adding to this table is a decision, not a workaround.** A divergence that is not
here is a defect.

**RETIRED 2026-08-28: the `writeValueWith*` deferral.** This table briefly carried
a sixth row — `writeValueWithResponse` / `writeValueWithoutResponse` recorded as
*absent, deferred until there is an acknowledgement to resolve on*. TRA-1153
5b-client landed that acknowledgement, so both methods now exist and are fidelity
clauses above rather than divergences here. Its arm-A absence check went red by
design on the commit that added them, which is the whole reason a deferral was
safe to record: **the trigger fired the check, the check forced the row's
deletion.** A deferral without a mechanism that fails when it expires is just a
comment.

**One consumer-side claim in the retired row has also expired**, and is corrected
rather than deleted because it was this document's motivating example: platform's
`cs108-ble-transport.ts` **used to declare** both methods on a hand-written
interface while calling neither — a contract that existed only as the consumer's
wish. Platform removed those declarations in their #598 precisely because the mock
lacked the methods, and restores them now that it has them. So the example is
history, not a live defect, and stating it in the present tense would send the
next reader looking for a fiction that is no longer there.

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

- **CLOSED 2026-08-28 — `write_ack` and what `writeValue()` resolves on.** This
  entry asked which `writeValue` consumes the ack. By the time 5b-client landed
  the question had dissolved rather than been answered: TRA-1187 item 4 deleted
  `src/node/`, so **there is one `writeValue`, not three.** The per-client
  decision that this entry existed to force is the same asymmetry TRA-1187 was
  filed over, and deleting the second client removed it. The guarantees are now
  clauses under [Writes](#writes).
- **CLOSED 2026-08-28 — characteristic properties are now on the wire.** The
  `connected` frame carries `write_properties`, so `writeValueWithoutResponse()`
  refuses a characteristic that does not advertise the property, matching
  Chrome's `NotSupportedError`. This was the one place the mock was **looser**
  than the API it doubles — a call passing here and throwing in the browser,
  which is TRA-1187's motivating example pointed the other way. Verified on the
  real wire against the CS108: `{"type":"connected", … "write_properties":["write"]}`.
  Absent is deliberately not empty: a bridge that cannot report properties must
  not read as a device supporting none, so the field is omitted rather than sent
  as `[]` and the client does not gate.
- **WITHDRAWN 2026-08-28 — "the mock discards the bridge's refusal detail".** It
  does not. Recorded here because the claim was made confidently, propagated, and
  was wrong. Both sessions reproduced it independently: the mock surfaces
  `Device is busy: the command path is owned by another connection (session 'X')`
  verbatim, holder and remedies intact, all the way into the consumer's failure
  output. The original diagnosis came from a collision whose specs failed on
  *their own assertions and a connect timeout* — different paths — and the log
  was read as though it explained the test failure. **A real diagnostic, a real
  incident, and an invented causal link between them.**

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

  **Confirmed 2026-08-28**: `trakrf/platform` calls `testCommand` from nowhere —
  not in `src/`, not in its tests. The only callers anywhere are this repo's own
  unit tests and one e2e helper. Its keep-or-delete decision is therefore
  unconstrained by any consumer, and it is no longer urgent: the method was
  *broken* until the subscription gate above was added, and is now correct.
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
