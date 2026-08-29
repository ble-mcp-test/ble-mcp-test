# WebSocket protocol — the actual contract

**Status:** SPEC / derived from code, 2026-08-23. Companion to
`2026-08-23-python-bridge-rewrite.md`, which named "match the full protocol" as the port's acceptance
criterion. That criterion was a *count*; this is the contract.

**Provenance.** Everything in §§1-5 is read from `src/ws-handler.ts`, `src/ws-transport.ts`,
`src/bridge-server.ts`, `src/ble-session.ts`, `src/mock-bluetooth.ts` and `src/node/`. Where a claim
is inference rather than observed behaviour it is marked **[inferred]**. Nothing here comes from
`docs/`.

**Amended 2026-08-26 (TRA-1174).** §6 gains *Release timing* and *Idle release*; §7 is new. Those
are read from `bridge/`, not from the deleted TypeScript — the TS bridge is gone as of TRA-1163, so
this document is now the specification of the Python bridge rather than a port target derived from
its predecessor. Each addition says what prompted it.

**Amended 2026-08-27 (TRA-1153 item 5b).** §8 is new and specifies `write_ack`, the first message
type added to this protocol since the port. The §2 tables gain it, and gain the optional `write_id`
the client→server `data` frame now carries. **Ten message types traverse the wire as of this
amendment** — the "Corrected: 9" below is the count as it stood on 2026-08-23 and is left standing
as the history it is.

**Amended 2026-08-28 (TRA-1153 item 6 / TRA-1187).** §9 is new and specifies
`write_properties` on the `connected` frame — the second field added since the port, and the
first that describes the *peripheral* rather than the relay. The §2 server→client table gains it.

**Amended 2026-08-28 (TRA-1187 item 4).** `src/node/` is deleted, so **there is one client, not
two.** Every `NodeBleClient` citation below described a real second consumer when it was written;
none of them names live code any more. The §2 and §3a tables are corrected in place, because they
are read as the current contract. The §§1-5 *provenance* and *Correction to the ADR* notes are left
standing as the history they are — rewriting a dated finding to match today's tree destroys the
record of what was actually observed. Where a rationale below turns on `NodeBleClient`'s behaviour,
the rationale is kept and marked, because the decision it produced still stands.

Two of the three were absent because nothing had gone wrong in them yet. **Release timing was
absent, and four e2e specs encoded a contradictory assumption for months with nothing to contradict
them** — the document specified who may claim the path but never when it comes free, so a test
asserting the retired pooling behaviour read as plausible.

---

## Correction to the ADR, up front

The ADR asserts **13 message types** and lists them. The count is right by accident; **the
membership is wrong in two places.**

1. **`characteristicvaluechanged` is not a wire message.** It is the standard Web Bluetooth DOM
   event — `new CustomEvent('characteristicvaluechanged', …)` at `mock-bluetooth.ts:488`, dispatched
   through `addEventListener`/`dispatchEvent`. It never crosses the socket. I counted a DOM event as
   protocol.
2. **`ack` was missing from the list.** `node/NodeBleClient.ts:314` tests for it. Nothing sends it.

And a third, larger error in the same direction:

3. **`disconnected` is not a wire message either.** `ws-transport.ts:118-125` *synthesizes* it
   locally in the socket's `onclose` handler and hands it to `this.messageHandler`. The server never
   sends it. Consumers (`mock-bluetooth.ts:377`, `NodeBleClient.ts:264`) are reading a client-internal
   event, not a server message.

**Corrected: 9 message types actually traverse the wire.** The port is smaller than the ADR implied,
and the acceptance criterion should be this document rather than a number.

---

## 1. Connection establishment — URL query parameters

Parsed in `bridge-server.ts:40-79`. Nine parameters, not the five previously circulated.

| Param | Required | Type | Behaviour |
|---|---|---|---|
| `service` | **yes** | string | BLE service UUID, short or long form; UUID-normalized |
| `write` | **yes** | string | write characteristic UUID |
| `notify` | **yes** | string | notify characteristic UUID |
| `session` | no | string | session id; absent means a generated one **[inferred]** |
| `_mv` | no | string | mock version marker — see below |
| `force` | no | `'true'` | `forceConnect`; any other value is falsy |
| `deviceId` | no | string | optional device filter |
| `deviceName` | no | string | optional device filter |
| `timeout` | no | int | `parseInt(…, 10)` |
| `role` | no | `'writer'` \| `'observer'` | **Not from the TypeScript.** Added by TRA-1159; see §6. Absent means `writer`. Any other value is refused |

Missing any of `service` / `write` / `notify` → server sends `error` with
`"Missing required parameters: service, write, notify"` (`bridge-server.ts:84`).

**Provenance note.** `role` is the one parameter in this table with no TypeScript ancestor. It is
recorded here as an addition rather than as an observation, so the "everything here is read from
`src/`" rule at the top of this document stays true.

### `_mv` is version *observation*, not negotiation

`ws-transport.ts:50-61` sets `_mv` to the package version, under a comment calling it a "sneaky
version marker — only set by the mock, never documented." `bridge-server.ts:55-66` then:

- **absent** → four `console.warn` lines about bypassing the mock;
- **present but mismatched** → one `console.warn` about version mismatch.

**Both outcomes are server-side logging only.** No message is sent to the client, nothing is
rejected, no behaviour changes. Treat it as telemetry, not as a negotiation mechanism, and do not
port it as one. If real version negotiation is wanted, it does not exist yet and should be designed
rather than inherited.

---

## 2. Messages that actually cross the wire

### Server → client

| Type | Emitted at | When | Client action | Shape |
|---|---|---|---|---|
| `connected` | `bridge-server.ts:145` | BLE connection established | resolve connect | `{type, device: string, write_properties?: string[]}` — see §9 |
| `data` | `ws-handler.ts:88` | notification from device | deliver to notify handler | `{type, data: number[]}` **[inferred field]** |
| `error` | `ws-handler.ts:105`, `bridge-server.ts:84` | param validation failure, or operation error | reject pending op | `{type, error: string}` |
| `warning` | `ws-handler.ts:148` | non-fatal issue during cleanup | log, **keep waiting** | `{type, warning: string}` |
| `session_cleanup_complete` | `ws-handler.ts:127` | after `cleanup_session` | — **nothing consumes this** | `{type, sessionId, message}` |
| `force_cleanup_complete` | `ws-handler.ts:157` | after `force_cleanup` | resolve the cleanup promise | `{type, warning?: string}` |
| `admin_cleanup_complete` | `ws-handler.ts:188` | after `admin_cleanup` | — **nothing consumes this** | `{type, …}` |
| `write_ack` | `ws/server.py` `_receive_writer` | once per `data` frame accepted for writing | settle that write — **no client consumes it yet**, see §8 | `{type, ok: bool, mode: string, write_id?, error?: string}` |

### Client → server

| Type | Sent at | Server handler | Shape |
|---|---|---|---|
| `data` | `ws-transport.ts:135` | `ws-handler.ts:46` — write to device | `{type, data: number[], write_id?}` — `write_id` added by TRA-1153 item 5b, see §8 |
| `force_cleanup` | `ws-transport.ts:196` | `ws-handler.ts:52` | `{type, token?: string}` |

**Note on `warning`:** the client's handling is explicitly *"Continue waiting for completion"*
(`ws-transport.ts:176-178`). It is an interstitial notice inside a cleanup handshake, not a terminal
outcome. A port that treats it as terminal breaks cleanup.

---

## 3. Dead protocol audit

platform's framing of "vestigial" splits into three genuinely different defects. The distinction
matters because the instinct on *unused* is to delete, and for one category that is exactly wrong.

### 3a. No sender — safe to drop

Handlers exist for messages nothing ever sends. Dead weight; the port should omit them.

| Type | Handler | Sender |
|---|---|---|
| `cleanup_session` | `ws-handler.ts:56` | none in `src/` |
| `admin_cleanup` | `ws-handler.ts:60` | none in `src/` |
| `cleanup_complete` | `ws-transport.ts:180` | **none in `src/`** |
| `ack` | **none in `src/`** — was `NodeBleClient.ts:314` until TRA-1187 item 4 | none in `src/` |

`cleanup_complete` deserves attention: the client waits on
`msg.type === 'cleanup_complete' || msg.type === 'force_cleanup_complete'`. Only the second is ever
sent, so the path still resolves — the first is a name that was never implemented, or was renamed on
one side only. **[inferred]** Given the server sends `session_cleanup_complete`, the likeliest story
is a rename that updated the server and not the client.

### 3b. No consumer — the dangerous category

**These are messages the server emits into a void.** That is the failure-becomes-silence class, not
unused code, and the fix is to wire up a consumer, not to delete the emitter.

| Type | Emitted at | Consumer |
|---|---|---|
| `session_cleanup_complete` | `ws-handler.ts:127` | **none** |
| `admin_cleanup_complete` | `ws-handler.ts:188` | **none** |

Both are the *responses* to the two no-sender requests in 3a, so each is half of a request/response
pair where **neither half is wired**. `cleanup_session` → `session_cleanup_complete` is a complete
round trip that no client initiates and no client would hear.

Practical consequence: these two pairs are the only part of the "seven-member cleanup/admin family"
that is genuinely dead on both ends. **They can be dropped as a unit** — that is a real reduction in
port scope, and it is safe precisely *because* both halves are dead. Contrast with a lone unconsumed
emitter, which would be a silent failure path.

### 3c. Phantom — declared, never used anywhere

Four members exist only inside TypeScript union declarations, with **zero** occurrences elsewhere in
`src/`:

- `ws-transport.ts:4` — `eviction_warning`, `keepalive_ack`
- `node/types.ts:12` — `scan_result`, `notification`

Never sent, never consumed, never referenced. The type declarations describe a protocol richer than
the one that exists. **[inferred]** Aspirational, matching Mike's "either aspirational or just ended
up being less necessary."

---

## 4. Live traffic vs implemented protocol

The third category platform asked about — live protocol with no live consumer, where a correct
implementation quietly rots.

In practice, platform↔bridge traffic is **`connected` + `data`**. The Rust bridge has run for hours
implementing only those two and drives the entire soak. Everything in §2 beyond those two is
implemented, correct, and unexercised by the primary consumer.

That is not an argument for deleting it — `error` and `warning` in particular are exercised by the
Node client and by this repo's own e2e suite. It *is* an argument for the port's sequencing: build
`connected`/`data` first and get the soak running against Python, then `error`/`warning`, then
decide on the cleanup family with §3 in hand.

---

## 5. What the port must implement

**Required (9 wire messages minus the dead pairs = 7):**
`connected`, `data` (both directions), `error`, `warning`, `force_cleanup`, `force_cleanup_complete`.

**Drop (dead on both ends):** `cleanup_session` / `session_cleanup_complete`,
`admin_cleanup` / `admin_cleanup_complete`.

**Drop (no sender):** `cleanup_complete`, `ack`.

**Do not implement (not protocol):** `disconnected` — the client synthesizes it from socket close;
`characteristicvaluechanged` — a DOM event inside the mock.

**Do not implement (phantom):** `eviction_warning`, `keepalive_ack`, `scan_result`, `notification`.

**Port as logging only:** `_mv` handling.

### Known defect to fix rather than port

`force_cleanup` is annotated in the client as broken: *"Sending force_cleanup request (this is
broken - creates zombies)"* (`ws-transport.ts:195`). It is the one cleanup path that *is* wired end
to end, and its own author flagged it. The port should not reproduce the behaviour without
understanding it; **[inferred]** the zombie is presumably a session or transport surviving the
cleanup it was asked to perform.

---

## 6. Ownership: one writer, many observers — TRA-1159

**Not read from `src/`.** This section specifies behaviour the Python bridge adds. The TypeScript
and Rust bridges do not implement it, and the gap is the point: neither of them refuses a second
writer in the case that actually happens.

### Why the old guard did not cover the common case

| | guard |
|---|---|
| TS / Noble | **session-level only** — `session-manager.ts:51-56` rejects a *different session* holding the transport |
| Rust | **none** — a bare accept loop clones the command sender per connection |

But `ble-session.ts:18` keeps `activeWebSockets = new Set<WebSocket>()`: multiple sockets per
session are a designed feature, all sharing one transport with full write access. And both repos
pin a fixed per-host session id (`ble-mcp-e2e-${hostname}` here, `trakrf-handheld-dev-${hostname}`
in platform). **Shared-writer was therefore the configured norm**, and the guard fired only in the
case that did not arise.

Ownership in the Python bridge is per **connection**. A second claim is refused even when the
session ids are identical.

### The two roles

- **writer** (the default) — claims the command path, is the only connection whose `data` frames
  reach the device, and is the only one for which a transport is built.
- **observer** — attaches read-only to the writer's notification stream. **No transport is built
  for an observer**, which is what makes read-only structural rather than conventional.

The observer role exists for a stated use: platform attaches the mock to watch the transport
stream while debugging unexpected reader behaviour. A pure single-client lock would block that;
unrestricted multi-client permits the hazard. Note that the hazard is specifically the *dev* path
— a second tab on `localhost:5173` during a soak arrives with the mock injected, the same pinned
session id, and full write access. The deployed build uses native Web Bluetooth and fails loudly at
the radio instead.

Role is **stated, never inferred**. Inferring it from arrival order would silently demote a second
client that meant to write, and its writes would vanish into a role it never asked for.

### What each refusal says

Every one of these is an `error` frame carrying a complete sentence, followed by a close. None of
them is a timeout and none is a bare socket close.

| situation | text |
|---|---|
| second writer | `Device is busy: the command path is owned by another connection (session '…'). Connect with role=observer to read the notification stream without writing, or with force=true to take the command path over.` |
| observer, nobody owns the path | `Nothing to observe: no connection owns the command path` |
| observer or forced writer, owner still connecting | `The command path is claimed but its device link is not up yet. This resolves in a moment; retry.` |
| observer sent a `data` frame | `This connection attached with role=observer and may not write to the device. The frame was discarded and the stream is still open.` — **the connection stays open**; read-only must not mean disconnect-on-mistake |
| owner left, or was evicted | `The connection that owned the command path has gone; this stream has ended` |
| this connection was evicted | `Evicted: another connection took the command path over with force=true (session '…').` |
| takeover abandoned | `Takeover abandoned: the connection holding the command path did not release its transport in time. The device link was left alone. Retry.` |

**The busy text must not collide with `mock-bluetooth.ts:249-262`'s retryable substrings.** That
list — `Bridge is disconnecting`, `Bridge is connecting`, `only ready state accepts connections` —
drives up to ten seconds of silent backoff. A collision would convert the loud refusal back into a
wait, which is the failure class the refusal exists to remove. Checked mechanically by
`test_the_busy_error_is_not_one_the_mock_silently_retries`, because wording is what drifts.

### `force=true` is the only takeover, and it is announced on both sides

`force` was parsed and then ignored by every previous bridge. It now displaces the current owner:

1. the displaced connection's transport is released, and the takeover **waits** for that — two
   transports must never hold the one radio;
2. the displacing connection receives a `warning` — **interstitial, before `connected`** — naming
   the session it evicted and saying that run is now invalid;
3. the displaced connection receives the eviction `error`, then its socket closes;
4. observers attached to the displaced owner receive the stream-ended `error` and close. The new
   owner's stream is a different device link, not a continuation.

Symmetry is deliberate. The 2026-08-23 incident had both halves of the human coordination protocol
fail — one side did not announce a destructive act, the other left a stale all-clear standing. A
rule that fires on only one side is not a rule.

### `warning` is interstitial

`ws-transport.ts:176-178` logs a `warning` and *continues waiting*. `HANDSHAKE_TERMINAL_TYPES` in
`bridge/src/ble_bridge/ws/protocol.py` names the types that do settle the client's connect promise
— `connected` and `error` — and `test_handshake_terminal_types_match_the_typescript_waiter` reads
that set back out of `ws-transport.ts` rather than trusting this document. Either side moving now
fails as an assertion instead of as a timeout.

### Release timing — the path comes free when the SERVER processes the close

**Added 2026-08-26.** Previously unspecified, and its absence was expensive.

An ordinary disconnect releases the command path. There is no grace period, no pooling and no
recovery window: a bridge that is merely running holds no radio. But the release lands when the
**server** processes the socket close, not when the client's `disconnect()` returns.

So a client that disconnects fire-and-forget can race its own next connect and be refused as busy
**naming its own session id** — which reads as an ownership bug and is a lifecycle one. Measured
during TRA-1163:

```
owns     21.733
refused  21.846   <- 6ms BEFORE the release
released 21.852
```

**Clients must await disconnect before reconnecting.** `MockBluetoothRemoteGATTServer.disconnect()`
is `async` for this reason; the e2e helpers in `tests/e2e/test-config.ts` await it, and did not
before.

Why this needed writing down: §6 above specifies *who may claim* the path in detail, and said
nothing about *when it comes free*. Four e2e specs asserted the retired session-pooling behaviour —
`'should handle rapid reconnections without delays'` among them, whose own comment read *"All
commands should work if pooling is working"* — and nothing in the governing document contradicted
them. A contract that is silent on a point does not refute a test that assumes the wrong answer.

### A second bridge is refused, not queued, and does not take the link

**Added 2026-08-26, measured on hardware (TRA-1174).** This was the ticket's longest-standing
unverified bullet: two bridges reaching the same ESP32 proxy for the same MAC — refuse, queue, or
take the link?

**Refuse.** Six trials, roles interleaved, one discarded warm-up. The second bridge fails at
`ADVERTISEMENT_TIMEOUT_S` every time, and **the holder is never disturbed** — it keeps the
device and is released only by its own idle timer.

> ⚠ **The measurement was taken at `ADVERTISEMENT_TIMEOUT_S = 30.0`; it is 15.0 since
> 2026-08-29 (TRA-1189).** The *finding* is unchanged and is why the value could be cut: the
> second bridge waits out the whole timeout having heard **nothing**, so this timeout is not a
> wait at all in the contended case — it is a delay in front of a verdict already determined at
> t=0. Halving it returns the same diagnosis twice as fast. Read the durations below as "the
> full advertisement timeout", not as thirty seconds.

The refusal is a normal `error` frame carrying the transport's own diagnosis:

> `device …:A7 was not heard advertising to proxy …:6053 within 15s. A peripheral already held in
> another connection does not advertise, so this most often means it is in use rather than absent.`
>
> *(quoted at 30s when measured; the sentence interpolates `ADVERTISEMENT_TIMEOUT_S`)*

**Since 2026-08-26 the refusal is immediate, not inferred.** The bridge asks the proxy which
addresses it already holds (`aioesphomeapi` pushes `allocated`) before falling back to the
advertisement wait. Measured on hardware: **0.16s instead of 30.25s**, with the reason stated —
*"the proxy reports this device is already connected to another client. It is in use, not absent;
nothing was disturbed."*

The advertisement wait remains the fallback, and must: an empty `allocated` list means either
"nothing held" **or** "this firmware does not report the list", and the two are indistinguishable.
The check refuses only on positive evidence and otherwise falls through.

**Which timeout fires is the signal.** An advertisement timeout means *in use or absent*; a connect
timeout would mean only *something failed*. Do not collapse them.

Two consequences for the cross-container question:

- **Safety already holds.** A second container cannot take the reader — the physical layer refuses
  it. No shared lock record is required to prevent the two-writer hazard.
- **The proxy is not the constraint.** It advertises `limit=4` slots, so both bridges connect to it
  happily; contention is at the single-connection peripheral, not the ESP32.

**Observed but unexplained, recorded rather than smoothed over:** while a challenger is attempting,
the holder's idle release runs **20s late** — 65.02s against a 45s timeout, in five of five trials,
reproducing to two decimal places; 45.02s when no challenger is present. `CONNECT_TIMEOUT_S` is
20.0. So the two processes are **not** fully isolated: one can move the other's timers. Mechanism
not established.

### Idle release

**Added 2026-08-26.** Client-visible and previously undocumented.

A writer that sends nothing for `BLE_MCP_IDLE_TIMEOUT` seconds (default 600; `0` disables) has its
device link and command path released and is told so in an `error` frame.

**Only frames from the client renew the lease.** Device notifications never do — the reader emits
unprompted traffic on its own timers, so an abandoned session would otherwise renew its own lease
forever, which is the failure this timeout exists to prevent.

### Known limit

Subscriber queues are unbounded, matching the owner queue that predates this. An observer that
stops reading grows memory. Bounding it would mean either blocking the transport callback or
dropping notifications silently, and both are worse; the honest resolution is a measured decision
alongside the firehose work rather than a guess.

---

## 7. The HTTP surface on the WebSocket port

**Added 2026-08-26 (TRA-1174).** Both behaviours below are contracts a consumer already depends on.
The first was an accident of the `websockets` library that platform came to rely on; it is now
pinned by a test in this repo, and stating it here is what makes it a promise rather than an
observation.

### Non-upgrade requests get `426 Upgrade Required`

Any plain HTTP request to a path other than `/status` falls through to the WebSocket handshake and
is answered `426`. This is a **guarantee, not an implementation detail**.

`trakrf/platform`'s `frontend/scripts/dev-bridge.js` probes the WS port over plain HTTP and treats
*any* HTTP status as "listening" and connection-refused as "not running". Narrowing this — answering
404, or serving something else on `/` — breaks that probe. `bridge/tests/test_status_endpoint.py::
test_every_other_path_still_gets_426` fails if it changes.

### `GET /status` — the read path for non-holders

Returns `200` with a JSON body describing the command path:

```json
{ "held": true, "session": "ble-mcp-e2e-mssb", "acquired_at": "2026-08-26T15:42:10Z",
  "held_seconds": 91, "ready": true, "device_name": "CS108Reader2603A7",
  "device_id": "…", "observer_count": 0, "version": "0.1.0" }
```

`held: false` reports `session`, `acquired_at` and `held_seconds` as `null`.

**Why HTTP rather than a WebSocket frame.** `navigator.bluetooth.getAvailability()` runs in a
browser before any connection exists. Asking over WebSocket would mean opening a connection to
discover whether opening a connection is possible, and the MCP control socket is a unix socket a
browser cannot reach.

**`ready` distinguishes claimed-but-connecting from driving the device.** A claim exists from the
instant it is taken, before `connect()` returns; those are different situations to walk in on.

**There is deliberately no heartbeat and no TTL.** The port answering *is* the liveness signal — a
dead bridge refuses the connection. A TTL exists to expire a record that can outlive its writer, and
this record cannot: it **is** the writer. **That argument does not generalise.** A lock record shared
across bridge processes has an independent lifetime and genuinely can outlive its holder, so the
cross-container half of TRA-1174 must solve the expiry problem this half designs out.

### CORS is derived from the bind

`Access-Control-Allow-Origin: *` and `Access-Control-Allow-Methods: GET` are emitted **only when
bound to loopback**. Off loopback the headers are absent entirely, so a browser cannot read the
endpoint cross-origin.

Conditional rather than static on purpose. `mcp-http-transport.ts:23` set `origin: '*'` on a
`0.0.0.0` bind and TRA-1161 deleted it — the hazard there was never `*` alone, it was `*`
**co-occurring** with a wide bind. Neither half is dangerous by itself, which is why that
combination survived review. Deriving the header from the bind makes the unsafe combination
unrepresentable rather than warned about.

---

## 8. `write_ack` — the outcome of a single write

**Added 2026-08-27 (TRA-1153 item 5b).** The tenth message type, and the first added since the port.
Until now a write was fire-and-forget on the wire: the client learned nothing about an individual
write, and learned about a *failed* one only as the session-ending `error` that followed it.

```json
{ "type": "write_ack", "ok": true, "mode": "with-response", "write_id": "w-42" }
{ "type": "write_ack", "ok": false, "mode": "with-response", "write_id": "w-43",
  "error": "device …:A7 is not connected; the proxy at …:6053 is still reachable" }
```

### `ok: true` is only as strong as `mode`, which is why `mode` is on the wire

`ok: true` means `transport.write()` returned without raising. Under `mode: "with-response"` — a
GATT Write Request, the default since item 5a — that is the peer's ATT layer confirming receipt, and
the ack is a real acknowledgement. Under `mode: "without-response"` it is a Write Command: nothing
comes back from the peer, and `ok: true` means only that the frame was handed to the proxy without
error.

The mode is a **runtime knob** (`ble_bridge.write_mode`, flipped over the control socket so an A/B
can interleave arms), so a client cannot infer it from configuration. Putting it in every ack is
what stops `ok: true` being an assertion the bridge has no basis for — an ack that always succeeds
would be a control that cannot go red wearing a protocol message. It is read once per write, before
the write, so the ack reports the mode that write actually used rather than whatever the knob says
by the time the ack is composed.

### The correlation token is `write_id`, and it is deliberately not `id`

**The reason is historical as of 2026-08-28; the decision stands.** `src/node/` was deleted by
TRA-1187 item 4, so the collision described here can no longer occur — but `write_id` is on the wire
and in the Python bridge, renaming it would be a protocol break for nothing, and a correlation token
distinct from a transport-level message id is the right shape regardless of which client is reading
it. Kept because a reader who finds `write_id` and wonders why it is not `id` deserves the answer.

`src/node/NodeBleClient.ts:241` dispatched on `msg.id` **before** it looked at `msg.type`, and
*deleted* the handler it dispatched to:

```ts
if (msg.id && this.messageHandlers.has(msg.id)) { … handler(msg); return; }
```

An ack carrying `id` that collided with a pending `sendMessage()` id (`randomUUID()`, `:306`) would
be delivered to the wrong handler and consume it, so the real response would then be dropped —
surfacing as a hung or mis-resolved request mentioning nothing about writes. Naming the field
`write_id` makes that collision **unrepresentable** rather than merely unlikely.
`test_write_ack_never_uses_the_field_name_id` reads the hazard back out of the client, so it fails
if either side moves.

### The client supplies the token; the bridge echoes it verbatim

`write_id` is optional, opaque, and never interpreted by the bridge. When present on a `data` frame
it is echoed on that write's ack; when absent, the ack carries no `write_id` field at all — absent
rather than null, because a client cannot tell an echoed null from a missing echo.

Two alternatives were considered and rejected:

- **Bridge-assigned sequence numbers.** The client would still have to derive which number is its
  own write, which is positional correlation with extra steps.
- **Positional correlation with no token.** The relay is serial — `_receive_writer` awaits each
  write before reading the next frame — so acks do arrive in write order, and a FIFO of pending
  writes *would* line up. It breaks on the frames the relay **drops before writing**: an undecodable
  or malformed frame produces no ack, so every subsequent ack would be attributed to the write
  before it, silently. That is a wrong answer that looks like a right one, which this document's
  companion failure classes exist to keep out of the protocol.

### What is and is not acknowledged

| situation | ack |
|---|---|
| `data` frame written to the device, no error | `{ok: true, mode}` |
| write raised `TransportError` | `{ok: false, mode, error}` — the transport's own sentence, verbatim |
| write raised anything else | `{ok: false, mode, error}` — prefixed by `WRITE_FAILED_PREFIX` |
| frame undecodable, not `data`, or a malformed payload | **none** — nothing was attempted, so there is no outcome to report |
| observer sent a `data` frame | **none** — it is refused with an `error` and discarded, as §6 specifies |

### `ok: false` is terminal today

A failed write still ends the session, exactly as it did before this message existed: the transport
is cleaned up, the client receives the session-ending `error` frame, and the socket closes. The ack
is sent **before** that teardown, so the client learns *which* write failed and only then that the
session is over.

So `ok: false` means "this write failed and the link is going down", not "retry on this connection".
Recovery is reconnection. Making some write failures non-fatal would be a behaviour change with its
own blast radius and is deliberately not part of this amendment.

### The emitter ships ahead of any consumer, on purpose

As of this amendment **nothing consumes `write_ack`.**

**Simplified 2026-08-28 by TRA-1187 item 4.** The question used to be *which of three `writeValue`
implementations* consumes it — `mock-bluetooth.ts:137`, `node/NodeBleCharacteristic.ts:57`,
`node/NodeBleClient.ts:44`. Two of those were in `src/node/` and are deleted, so **there is one
`writeValue` left**, `mock-bluetooth.ts:137`, and the per-client decision that produced the
asymmetry TRA-1187 was filed over no longer exists. What remains is a single contract question —
what `writeValue()` guarantees once it consumes an ack, and whether it gains the ability to reject —
and that is TRA-1153 item 5b-client, now unblocked. **`writeValue()` cannot reject until that
lands.**

Shipping the emitter alone is safe rather than assumed-safe: both surviving client message handlers
(`ws-transport.ts:78`, `mock-bluetooth.ts:530`) are `if`/`else if` chains with no throwing default,
so an unrecognised `write_ack` is ignored.

This is the one shape §3b of the spec calls dangerous — an emitter with no consumer is a silent
failure path, not merely unused code — so it is held open deliberately and visibly rather than by
omission. `bridge/tests/test_protocol.py` names it in `AWAITING_CONSUMER` alongside the ticket that
will close it, and asserts the set **exactly**: the moment a client branches on `write_ack`, the
stale exemption fails and has to be removed.

---

## Open items

1. Exact field shapes for `data` are marked **[inferred]** — encoding (`number[]` vs base64) should
   be confirmed against a live capture before the port freezes the format.
2. `admin_cleanup_complete`'s payload was not fully read; it is slated for deletion, so this matters
   only if that decision reverses.
3. The `force_cleanup` zombie defect needs a root cause before the port decides whether to
   reimplement, fix, or drop it.

---

## 9. `write_properties` — what the peripheral says it supports

**Added 2026-08-28.** An optional field on `connected`, carrying the write characteristic's own
account of its capabilities as the peripheral reports them, lowercase, in bleak's naming:

```json
{ "type": "connected", "device": "6C:79:B8:26:03:A7", "write_properties": ["write"] }
```

### Why a relay is reporting a device attribute at all

Everything else on this wire describes the relay: who owns the command path, whether a write
landed, what the link is doing. This describes the **device**, and it is here because a client
cannot otherwise be as strict as the API it doubles.

Real Chrome throws `NotSupportedError` when `writeValueWithoutResponse()` is called on a
characteristic that does not advertise the property. The CS108's `0x9900` advertises
`['write']` — write-with-response only — so that call is illegal against it. Without this field
the mock cannot know, and **accepts a call that the browser rejects**: a test passing against
the double and failing against the real thing, which is the defect TRA-1187 exists to prevent,
pointed the other way.

### Omitted, never empty

A transport that cannot report properties leaves the field **out**. It is never sent as `[]`.

The two are different claims — "I do not know" versus "this device supports nothing" — and they
demand opposite client behaviour: do not gate, versus refuse every write. A client cannot
distinguish an echoed empty list from a missing echo, so the encoder does not create the
ambiguity. Same reasoning as `write_id` in §8.

### Where it comes from

`esphome.py` reads `properties` off the resolved write characteristic and puts it on
`DeviceInfo`; `ws/server.py` passes it to `encode_connected`. It is the same value already
printed in the per-connection `write path: mode=… properties=…` log line, which TRA-1153 §2
asked to have re-derived where the write actually happens — so the log line and the wire field
cannot disagree.

**A transport that does not know may return an empty tuple**, and the field then disappears
from the frame rather than misreporting the device.

## 10. `error` frames carry a `code` — TRA-1187, 0.12.0

Every `error` frame carries a machine-readable `code` alongside its prose:

```json
{"type": "error", "error": "Device is busy: the command path is owned by another connection (session 'abc'). …", "code": "DEVICE_BUSY"}
```

**A client MUST discriminate on `code` and MUST NOT match on `error`.** The
message is prose for a human reading a log and is free to be reworded; the code
is the interface.

`code` is **required** at every emission site. `encode_error()` takes it as a
positional argument and raises on anything outside `ERROR_CODES`, so a typo is a
crash in the bridge rather than an unrecognised code the client silently declines
to act on. A default value was considered and rejected: a default is how half the
frames end up carrying a placeholder nobody notices.

| code | when |
|---|---|
| `MISSING_PARAMS` | service / write / notify absent or blank |
| `INVALID_PARAM` | a parameter was present but unusable |
| `DEVICE_BUSY` | another connection owns the command path |
| `NOT_READY` | claimed, device link not up yet — **the only retryable one** |
| `NOTHING_TO_OBSERVE` | no connection owns the path, so there is no stream |
| `TAKEOVER_STALLED` | the displaced session did not release in time |
| `TRANSPORT_FAILED` | the device link could not be established |
| `IDLE_TIMEOUT` | the lease expired with no frame from the client |
| `WRITE_FAILED` | a write failed after the handshake |
| `EVICTED` | another connection took the path with `force=true` |
| `STREAM_ENDED` | the owner is gone; an observer's stream is over |
| `OBSERVER_MAY_NOT_WRITE` | a `role=observer` connection tried to write |

### Why this replaced substring matching, and what it cost

The client used to match message **substrings** to decide whether a connect was
worth retrying. That list had already rotted in a way nothing could catch: it held
`Bridge is disconnecting`, `Bridge is connecting` and `only ready state accepts
connections` — **TypeScript-bridge-era wording, none of which this bridge has ever
sent.** So `maxConnectRetries` could not fire at all.

Its symptom was the **absence** of a retry. Nothing fails when a retry that would
have succeeded never happens, which is why it survived a replatform, a soak, and a
measured cut of the very retry budget it had disabled.

A code cannot decay that way, and two guards hold it mechanically across the
language boundary rather than by review:

- `test_every_retryable_code_is_one_we_send` — every code the client retries on is
  one this bridge can emit
- `test_the_retryable_set_matches_the_servers_own_declaration` — both sides declare
  the retryable set and must agree

### `DEVICE_BUSY` is deliberately not retryable

Another connection owns the command path; waiting does not change that. Retrying
converts a precise refusal into a long pause followed by some other failure — the
same class of defect, reintroduced by a one-line edit.
`test_the_busy_refusal_is_not_one_the_mock_silently_retries` enforces it.

