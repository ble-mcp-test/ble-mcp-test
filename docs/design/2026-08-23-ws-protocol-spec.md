# WebSocket protocol — the actual contract

**Status:** SPEC / derived from code, 2026-08-23. Companion to
`2026-08-23-python-bridge-rewrite.md`, which named "match the full protocol" as the port's acceptance
criterion. That criterion was a *count*; this is the contract.

**Provenance.** Everything here is read from `src/ws-handler.ts`, `src/ws-transport.ts`,
`src/bridge-server.ts`, `src/ble-session.ts`, `src/mock-bluetooth.ts` and `src/node/`. Where a claim
is inference rather than observed behaviour it is marked **[inferred]**. Nothing here comes from
`docs/`.

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
| `connected` | `bridge-server.ts:145` | BLE connection established | resolve connect | `{type, device: string}` |
| `data` | `ws-handler.ts:88` | notification from device | deliver to notify handler | `{type, data: number[]}` **[inferred field]** |
| `error` | `ws-handler.ts:105`, `bridge-server.ts:84` | param validation failure, or operation error | reject pending op | `{type, error: string}` |
| `warning` | `ws-handler.ts:148` | non-fatal issue during cleanup | log, **keep waiting** | `{type, warning: string}` |
| `session_cleanup_complete` | `ws-handler.ts:127` | after `cleanup_session` | — **nothing consumes this** | `{type, sessionId, message}` |
| `force_cleanup_complete` | `ws-handler.ts:157` | after `force_cleanup` | resolve the cleanup promise | `{type, warning?: string}` |
| `admin_cleanup_complete` | `ws-handler.ts:188` | after `admin_cleanup` | — **nothing consumes this** | `{type, …}` |

### Client → server

| Type | Sent at | Server handler | Shape |
|---|---|---|---|
| `data` | `ws-transport.ts:135`, `NodeBleClient.ts:50,376` | `ws-handler.ts:46` — write to device | `{type, data: number[]}` |
| `force_cleanup` | `ws-transport.ts:196`, `NodeBleClient.ts:322` | `ws-handler.ts:52` | `{type, token?: string}` |

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
| `ack` | `NodeBleClient.ts:314` | none in `src/` |

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

### Known limit

Subscriber queues are unbounded, matching the owner queue that predates this. An observer that
stops reading grows memory. Bounding it would mean either blocking the transport callback or
dropping notifications silently, and both are worse; the honest resolution is a measured decision
alongside the firehose work rather than a guess.

---

## Open items

1. Exact field shapes for `data` are marked **[inferred]** — encoding (`number[]` vs base64) should
   be confirmed against a live capture before the port freezes the format.
2. `admin_cleanup_complete`'s payload was not fully read; it is slated for deletion, so this matters
   only if that decision reverses.
3. The `force_cleanup` zombie defect needs a root cause before the port decides whether to
   reimplement, fix, or drop it.
