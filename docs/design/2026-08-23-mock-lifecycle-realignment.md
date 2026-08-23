# Mock lifecycle realignment — design (not implementation)

**Status:** DESIGN / for review. Verdict is **A-prime** (mock-local fidelity + one additive protocol
message), derived jointly with the platform session (platform-9b), which extracted the consumer
contract from `cs108-ble-transport.ts`. Two items still need Mike: the `write_ack` completion
semantics (Q1) and confirmation that the consumer-side write-failure fix lands alongside (Q2).

**Goal:** Realign `src/mock-bluetooth.ts` so its `navigator.bluetooth` surface faithfully models the
real BLE lifecycle (connect → discover → bind → subscribe → notify → unsubscribe → disconnect)
instead of flattening connect+bind+subscribe into one implicit operation, and so `writeValue()`
resolves on write completion rather than on enqueue. The app conforms to the native lifecycle; the
mock is the divergent party — this makes it stop diverging.

**Why now:** TRA-1149 (PR #42) gave the bridge discrete `BleTransport` primitives, and the overnight
soak (407 runs, esphome backend, **0/407 proxy resets**) established the backend is stable enough to
iterate the client contract against.

## Premise (Mike's framing, load-bearing)

> "Interactive testing with native hardware works and is quite stable. The platform connection code
> is built around the native BLE lifecycle. It's the mock that flattens it out."

The app is correct; the mock loses fidelity.

## Purpose & rationale (Mike's words — the standing justification)

> "The purpose of this mock: it is to enable automated testing from platform without the user
> gesture, and it enables a future path to CI testing from a runner with no hardware. The more
> closely the native implementation and the mock align the more valid the testing becomes."

Consequences this design leans on:
- **`requestDevice()` requires a user gesture** — that is *why* the mock exists, and it puts the mock
  on the critical path for **all** platform e2e, not just BLE-specific tests. Fidelity bugs here
  degrade the whole suite's validity.
- **"The more closely they align, the more valid the testing" is the justification for the whole
  realignment.** Alignment *is* the deliverable — so items 4/5/6/8 need **no** wedge claim and never
  did. It also settles A-vs-B permanently in A-prime's favour: go exactly as far as the consumer
  contract requires and no further, because fidelity is measured against what the app actually depends
  on, not against an abstract ideal.
- **CI-without-hardware** (future, out of scope) implies a mode with no bridge and no device at all —
  canned responses or recorded traces. The lifecycle split specced here is a *prerequisite* for it
  (you cannot fake connect/discover/subscribe/notify/write as distinct steps until they are distinct
  steps), which is another reason to do the split now.
- **Network-only backend → remote hardware-in-the-loop (a nearer, stronger step).** Retiring btleplug
  retires the local-radio requirement — Mike: "if we retire btleplug then this box goes away." A
  network-only (esphome) backend means HIL testing can run from **any** box with LAN reach to the
  proxy, including a CI runner. That's a concrete step toward the CI goal and arguably stronger than
  "CI with no hardware": it's *real* hardware driven remotely. Bigger decision than this doc (Mike's),
  but it reframes the esphome backend's value — worth a line in PR #42's description too.

## The consumer contract = acceptance criteria

Extracted by platform-9b from the full 450-line `cs108-ble-transport.ts`. Nine of ten items are
satisfiable mock-local; one (item 7) needs an additive protocol message. **This table is the
acceptance criteria for the realignment.**

| # | Contract item | Where it lands |
|---|---|---|
| 1 | `requestDevice` → device with `.gatt` | mock-local (already) |
| 2 | `gatt.connect()` → server; `server.connected` true and maintained | mock-local |
| 3 | `getPrimaryService(uuid)` throws if not connected | already correct |
| 4 | `getCharacteristic(uuid)` returns a **stable** object per UUID | mock-local (cache in the existing Map) |
| 5 | `startNotifications()` actually gates delivery | mock-local |
| 6 | `event.target.value` is a **real DataView**, valid at dispatch | mock-local (today it's a duck-typed object) |
| 7 | `writeValue()` resolves on **write completion**, not on send; can reject | **needs protocol (`write_ack`)** |
| 8 | `stopNotifications()` actually stops delivery | mock-local |
| 9 | `gattserverdisconnected` fires on link loss | already correct |
| 10 | `gatt.disconnect()` synchronous; `server.connected` → false | mock-local |

## The four divergences (verified in `src/mock-bluetooth.ts`)

1. **`startNotifications()`/`stopNotifications()` are no-ops** (99-108); no subscribed state. (items 5,8)
2. **`getCharacteristic()` (176-179) / `getPrimaryService()` (313-318) mint a new object each call.** (items 4)
3. **The `characteristics` Map (335) is a fan-out registry, not the identity cache it resembles** —
   only `.set()`/`.forEach()`, never `.get()`. Each new characteristic self-registers in its ctor
   (88), so every `getCharacteristic()` **evicts** the prior instance for that UUID; the evicted
   object keeps its handlers, still looks connected, and silently receives nothing. (item 4 — and a
   real latent bug: the app is safe only because it binds once and holds refs; margin is one stray call.)
4. **`writeValue()` resolves immediately** (91-97): `transport.send(data)` then return. No completion,
   no rejection. (item 7)

Plus item 6: `triggerNotification` (149-166) hands the app a hand-built object, not a real DataView.

**Common root:** the mock keeps state the real API derives from identity/subscription/completion,
then doesn't use it.

## Verdict: A-prime (NOT B)

**Do the nine mock-local items, plus one additive protocol message for item 7.** Reject (B)
protocol-level 1:1 (discrete connect/discover/subscribe over the wire): nothing in the consumer
contract asks for discrete bridge primitives, and (B) would change the WS wire protocol, rewrite the
bridge connect path, and **re-open keep-warm/session semantics** — a re-architecture the app never
requires. A-prime touches: `mock-bluetooth.ts` (all nine), and a single **additive**
`{type:"write_ack", id, ok, error?}` on the WS protocol correlated to a write id (backward compatible
— old clients that ignore it are unaffected).

### Part 1 — mock-local fidelity (items 4, 5, 6, 8, 10): correctness, NO wedge claim
- **Identity cache (4):** server holds `Map<uuid, MockService>`, service holds `Map<uuid, MockChar>`;
  `getPrimaryService`/`getCharacteristic` return cached-or-create. No second instance is ever minted,
  which **eliminates the finding-3 eviction bug by construction.**
- **Subscription gate (5, 8):** per-characteristic `subscribed: boolean`; `startNotifications` sets
  true, `stopNotifications` false; fan-out delivers only when `subscribed`. Pre-subscribe arrivals:
  drop (native behavior) unless Mike wants buffer-and-flush (Q3).
- **Real DataView (6):** deliver `event.target.value` as an actual `DataView` over an exact-size
  buffer, valid at dispatch (the consumer's `handleNotifications` reads `value.buffer/byteOffset/
  byteLength` — it already tolerates views, but a real DataView is the contract).
- **Disconnect (10):** `gatt.disconnect()` synchronous, `server.connected → false`.

**These four are behaviourally identical to today for THIS consumer** (see "null experiment" below),
so they carry **no wedge-rate claim**. They are correctness for the general case and they kill a
silent-failure bug. Justify them on that, nothing more.

### Part 2 — the write path (item 7): the ONE part with a live hypothesis
This is the only place mock and native diverge in *observable behaviour* rather than bookkeeping,
so it is the only part that could move the 8.1% wedge rate — and even that is a hypothesis, not a
finding.

- **Protocol:** additive `{type:"write_ack", id, ok, error?}`; the mock tags each write with an `id`,
  returns a Promise that resolves/rejects when the correlated ack arrives (with a timeout).
- **Pacing hypothesis (unmeasured):** the consumer serializes its command queue on
  `await writeValue()` behind a `commandInProgress` flag. Native resolves on GATT completion, so the
  serialization is real; the mock resolves on enqueue, so it is **inert** — commands can be issued
  back-to-back faster than the CS108 ever sees on native. *Whether the CS108 actually misbehaves
  under unpaced writes is NOT established — measure it before staking anything on it.*
- **Rejection path (structural gap):** the consumer's retry logic substring-matches browser errors
  ("GATT operation already in progress", "Device busy", "GATT Server is disconnected"). The mock can
  never reject, so that entire retry path is **unreachable and untested through the mock**. A
  `write_ack` that can carry failure unlocks it.
- **⚠️ Two-sided — this is a hard gate, not a footnote:** a `write_ack` the consumer ignores buys
  nothing. The consumer's write-failure signalling is structurally discarded today (see below), so
  A-prime's write_ack **only pays off if the platform-side write-failure fix lands with it.**
  platform-9b is raising that fix with Mike; this design assumes it as a co-dependency.

### Write-type decision (Q1) → (b) real write-with-response — and it's a spec violation, not just fidelity

`write_ack` should signal **real write completion**, which requires the bridge to switch the write
type from without-response to with-response. This is settled by evidence, not preference:

- **The write is currently non-conformant.** A real descriptor read (this session's aioesphomeapi
  GATT discovery via the proxy, reading the CS108's actual table) shows write char `0x9900` handle 18
  with **`properties = 8` (0x08 = Write / with-response)**; the Write-Without-Response bit is `0x04`,
  absent. Both backends issue write-without-response anyway (`ble_esphome.rs:501 response:false`;
  `ble_btleplug.rs:208,227 WriteType::WithoutResponse`) — an **ATT Write Command the characteristic
  never advertised.** It works only by CS108 leniency, not by contract.
- **(a) dispatch-ack is worse than it looks:** resolving `writeValue()` on "bridge handed it to the
  adapter" has no native analogue, leaves the consumer's `commandInProgress` serialization pacing
  against nothing (the exact defect item 7 exists to fix), and cannot carry the GATT error strings the
  retry path substring-matches — so it bakes the divergence in while looking fixed. Don't.

### The write-loss lead — DEMOTED to a hypothesis behind a large confound

The mechanical story is real: Write Without Response = ATT **Write Command** (no response, no
confirmation, no flow control — droppable under buffer pressure, silently); Write With Response = ATT
**Write Request** (client awaits `ATT_WRITE_RSP`, paced by the link). Under a dense notify flood a
dropped STOP Write Command → no ACK → worker waits 5s → the exact wedge signature.

**But do NOT carry "mock/write-only, therefore write-loss" — it is confounded, badly.** All 33 wedges
on record happened on THIS box: an **Intel Celeron N3050 (2015 Braswell, 2 cores), saturated at load
~2.7–2.9 for the whole 8h soak** (Chromium + vite + the Rust bridge + watchdog contending). Every
"never reproduced on native" data point came from a MacBook / Android / iPad — **~10× faster CPUs
doing nothing else and not also hosting the bridge**. ADR 0006's mechanism is main-thread **CPU
starvation**, so "mock-only" and "slow-saturated-CPU-only" are perfectly confounded in every
observation either side has cited. My earlier "structurally impossible on native" was wrong (or
unproven): a 10× CPU gap explains the native cleanliness just as well, and it was present the whole
time. Retracted.

**Counter-evidence too:** the pre-#582 wedged run-4 capture shows STOP sent at 424ms, reader STOP-ACK
at 457ms (`32 F1 80 02 00`, 33ms RTT) — the write was received and acked, and the app still timed out.
There, write-loss is ruled out and starvation is the explanation. (Pre-#582; the residual 8.1% may
differ.)

**Experiment 1 (decisive — gates the write-loss lead): swap the CPU, hold the topology.** Run the
**ENTIRE** stack — vite, Playwright, AND the bridge — on mssb (Ryzen HX370, 96GB); this box runs
nothing. Because the esphome backend has **zero local-hardware dependency** (`ble_esphome.rs` is a
`TcpStream` to host:port — no bluez/dbus/hci/adapter; `transport.rs:46` "never constructs a btleplug
Manager"; guarded by `build_esphome_does_not_touch_btleplug`), the bridge runs anywhere with LAN
reach to the proxy at `192.168.50.170` — the same LAN path used today.
```
notification path   browser<->bridge   bridge<->proxy
  today             LOCALHOST           LAN
  correct (Exp 1)   LOCALHOST           LAN     (identical — bridge moves to mssb WITH the browser)
  WRONG (do not)    LAN  <- new hop     LAN     (browser on mssb, bridge here: changes the WS path under test)
```
Keeping the browser↔bridge WebSocket on **localhost** is the whole point — that link *is* the
notification/stop-ACK delivery path under investigation; adding a LAN hop to it would confound CPU
with network latency/jitter/Nagle. Entire-stack-on-mssb keeps that link localhost, so **the only
variable that changes is the CPU** (N3050 2-core saturated → Ryzen HX370). Bonus: it also removes
both Claude sessions from the box under test (a second uncontrolled load — active vs quiet hours 12.5%
vs 7.3%, χ²≈p 0.15, noise but present).
```
wedge rate collapses  -> CPU-bound starvation; ADR 0006 confirmed; mock/write path exonerated;
                         TRA-1150's "user-facing" claim needs revisiting (users aren't on Braswell)
wedge rate holds ~8%  -> mock/write path genuinely implicated; the write-loss lead gets much stronger
```
**Experiment 2 (only if Exp 1 doesn't collapse it):** a POST-#582 **bridge-side capture on a wedged
run** — shows directly whether the STOP Write Command got through, separating write-loss from
starvation.

**(b) does NOT depend on any of this.** It is justified on the **spec-conformance argument alone** —
`0x9900` advertises `0x08` (with-response) and not `0x04`, so write-without-response is an unadvertised
ATT operation, full stop, worth fixing regardless of what causes the wedge. The write-loss lead is a
separate hypothesis that Experiment 1 must clear before it may be cited in support of (b).

### ⚠️ ESCALATION — Mike's explicit sign-off required; NOT folded into PR #42

(b) changes **shipped bridge behaviour on the real hardware path for BOTH backends**, so it is not an
implementation detail of the mock work:
- **PR #42 merges AS-IS.** Its write-without-response is not a regression #42 introduced — the write
  path predates it and matches the existing btleplug backend. The write-type change is a **separate,
  signed-off change** spanning both backends.
- **Needs its own soak** (reusable harness: `/tmp/soak/run-soak.sh`, `results.tsv`, verdict classifier
  = stop-scanning timeout AND readerState Error; 407 runs ≈ 8h) plus a **before/after inventory-timing
  measurement** — write-with-response adds an ATT round trip per write. Config-phase writes already
  carry the CS108 ~150ms settling delays (unaffected); the STOP/abort write specifically becomes paced
  (the intent). Do not assume it's free.
- Recommendation, with the properties=8 evidence and throughput caveat attached, for Mike's call.

## Why the "gating vs 8.1% wedge" experiment is NULL (do not run it)

Recorded so nobody re-derives it. `handleTransportMessage` is guarded `if
(notificationHandlers.length > 0)`. Handlers exist only after `addEventListener`. The consumer always
pairs `startNotifications()`+`addEventListener` and `stopNotifications()`+`removeEventListener`
adjacently. So delivery is **already** effectively gated — on listener attachment rather than on
subscription state — and proper subscription gating is behaviourally identical for this consumer.
Fixing items 5/8 will not move the wedge rate by one run. (Two other tidy stories — main-thread
starvation, JSON.parse cost — already died on measurement today. Same discipline here.)

If anything in this work can move 8.1%, it is item 7's pacing — and only if measured.

## Consumer-side defects (platform's, not ours — context that bounds the mock)

platform-9b found these in the same read and is raising them with Mike. They matter because they
change what a faithful mock can usefully surface:
- **Write-failure signalling discarded:** queue entry typed `resolve:(success:boolean)=>void` but
  constructed `resolve:()=>resolve()` (drops the arg); caller does not await. Of three failure paths,
  only "retries exhausted" posts `ble:error`; "queue full (≥5)" warns only, "!isConnected()" silently
  `resolve(false)` — worker told nothing either way, so it waits out its 5s → **"Failed to stop
  scanning: Command timeout."** A SECOND independent manufacturer of TRA-1150's exact signature, with
  no reader/bridge/mock involved. → the write_ack fix must land on both sides.
- `isConnected()` checks object presence (`device && server && writeCharacteristic`), never
  `server.connected`.
- `requestDevice` builds a two-element `filters` array (OR-semantics), so `deviceNameFilter` widens
  the match instead of narrowing — should be one filter object.

## Name-vs-service-UUID selection straddle (bridge-side audit)

Mike's standing decision: **service/characteristic-UUID matching is correct; device-name matching is
not.** The transition was made but the cleanup never finished. Audit of this repo (grep of `src/` +
`rust-ble-test/src/`):
- **The Rust bridge is already correct.** `rust-ble-test` reads **no** device name for selection — the
  btleplug backend matches by **service UUID**, the esphome backend by **MAC** (`config.rs`; the Rust
  binary has zero `deviceName`/`local_name` selection paths). So on the current (Rust) path there is
  **no active straddle**.
- **The straddle is dead legacy in the Noble path.** `noble-transport.ts:143` still selects by
  `config.deviceName`; `bridge-server.ts:78` reads a `deviceName` query param and `NodeBleClient.ts:157`
  sends it — all feeding the superseded Noble transport. Clean these up when Noble is retired
  (delete, not correct, per Mike).
- **`ble-session.ts` `deviceName` is legitimate labelling** — it's set from `device.name` *after*
  connect for status/logging (`/health`, session status), not used for selection. Keep.
- **Mock side (in scope here):** `mock-bluetooth.ts` extracts `namePrefix`→`deviceName` from
  `requestDevice` filters (647-685) and also extracts/overrides the **service UUID** (659). The Rust
  bridge ignores the name for selection, so this is inert for selection today — but the realignment
  should make the mock treat **service UUID as authoritative for selection** and `deviceName` as an
  optional label only, matching Mike's decision and the app's fixed service/char UUIDs.

Net: no fix needed on the current Rust path; the realignment should keep the mock service-UUID-first,
and the Noble-era `deviceName` selection plumbing is a delete-on-Noble-retirement item.

## Test plan (part of the deliverable)

The existing suite encodes **no** connect-and-bind-as-one assertion, so the lifecycle can be split
without rewriting it — but there is **no safety net for the new semantics**. Add:
- no notifications before `startNotifications()`; delivery stops after `stopNotifications()` (items 5/8);
- `getCharacteristic`/`getPrimaryService` return stable identity across calls; a second
  `getCharacteristic` must not silence the first (regression test for the eviction bug, item 4);
- `event.target.value instanceof DataView` and correct at dispatch (item 6);
- `writeValue()` resolves only after a `write_ack`, and **rejects** on `write_ack{ok:false}` — this
  gives the consumer's retry path its first coverage (item 7);
- a subscribed characteristic keeps receiving across reconnect when the app re-attaches to the same ref.

**Do not silently drop the Noble-reconnect coverage** in `connection-lifecycle.spec.ts` ("rapid
reconnections", "Noble state integrity across disconnect cycles"). Which of those still earn their
place needs the *why* behind each — part of what platform-9b is extracting. Keep them until then.

## `MOCK_CONFIG` (follow-up, measure then cut)

Noble-era constants (`connectRetryDelay 1200`, `maxConnectRetries 20`, `postDisconnectDelay 1100`,
`backoff 1.3`). With the Rust bridge, the delays and aggressive backoff are likely removable, but the
bridge's real session busy-states (`Bridge is connecting/disconnecting`, `only ready state accepts
connections`) still need a bounded retry. Keep a small retry for those, drop the Noble delays, gate
behind a no-regression soak over N reconnect cycles. Not urgent; trails Part 1/2.

## Open questions for Mike

1. **`write_ack` semantics → recommended (b), NEEDS YOUR SIGN-OFF.** Design converged on (b) real
   write-with-response completion (see "Write-type decision" above): it's a settled spec-conformance
   fix (0x9900 advertises 0x08 with-response only; the bridge issues an unadvertised Write Command),
   and it's the only variant that makes the consumer's serialization real and unlocks its retry path.
   **But (b) changes shipped bridge behaviour on real hardware for BOTH backends**, so it is your
   explicit call, not folded into #42 — approve (b) + its own soak + throughput measurement, or hold.
2. **Co-dependency:** confirm the platform-side write-failure-signalling fix lands with the write_ack
   (without it, item 7 is inert).
3. **Pre-subscribe delivery:** drop (native) or buffer-and-flush? (Default: drop.)
4. **Scope now:** Part 1 (correctness) + Part 2 (write_ack) together, or Part 1 first and Part 2 as a
   fast-follow once the consumer fix is scheduled?
5. **ADR 0006:** amend as part of this work, or leave to the platform side?

## Dependencies & references

- **Consumer contract** (above) — platform-9b, from `cs108-ble-transport.ts`. Acceptance criteria.
- **Two-sided write fix** — platform-side write-failure signalling; write_ack is inert without it.
- **ADR 0006** (platform `docs/adr`, Proposed): TRA-1150 as O(reads×unique) main-thread starvation;
  PR #582 fixed that term (~9× reduction). Identical on native, which does not wedge → the
  "user-facing" claim rests on reasoning the native observation contradicts. Likely needs amending.
- **Soak** (context): 407 runs / 8h, esphome, wedge 8.1% (32/396), **proxy-reset 0/407**,
  teardown-timeout 1.8%, flat. Harness `/tmp/soak/run-soak.sh` + `results.tsv` — **preserve (non-durable in /tmp).**
- Files: `src/mock-bluetooth.ts`, `src/ws-transport.ts` (this repo); `frontend/src/lib/device/transport/cs108-ble-transport.ts`, `tests/e2e/connection-lifecycle.spec.ts`, `tests/e2e/notification-simulation.spec.ts` (platform).
