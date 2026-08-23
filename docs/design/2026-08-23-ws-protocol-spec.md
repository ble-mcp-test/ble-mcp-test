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

Missing any of `service` / `write` / `notify` → server sends `error` with
`"Missing required parameters: service, write, notify"` (`bridge-server.ts:84`).

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

## Open items

1. Exact field shapes for `data` are marked **[inferred]** — encoding (`number[]` vs base64) should
   be confirmed against a live capture before the port freezes the format.
2. `admin_cleanup_complete`'s payload was not fully read; it is slated for deletion, so this matters
   only if that decision reverses.
3. The `force_cleanup` zombie defect needs a root cause before the port decides whether to
   reimplement, fix, or drop it.
