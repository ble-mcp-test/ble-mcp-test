# Rewrite the bridge server in Python — ADR

**Status:** PROPOSED / for Mike's sign-off. Decision made by Mike 2026-08-23; this record exists to
fix the *reasoning chain*, because a single change (leaving btleplug) voided four separate premises
at once and each will otherwise be re-litigated independently.

**Decision:** Rewrite the **server** (bridge + MCP) in Python. The **mock stays TypeScript on npm,
unchanged**. The Node client library (`src/node/`) also stays TypeScript — see *Port accounting*.

**Scope note:** this supersedes the Rust bridge direction (PR #41, `rust-ble-test/`), and it
subsumes TRA-1155 (btleplug retirement) — retiring btleplug is no longer a cleanup task, it is the
premise change that makes this decision correct.

---

## The voided-premise table

This is the load-bearing part of the document. Four decisions were each individually reasonable and
are now each individually obsolete, all for the same underlying reason: **ESPHome removes the local
radio from the bridge host.**

| Decision | Original reason | Why void now |
|---|---|---|
| **Rust** | btleplug sucked less than Noble | ESPHome removes the local radio entirely — the BLE stack quality argument no longer applies to anything |
| **`BLE_MCP_HOST=remote`** | bridge pinned to the radio box | bridge is co-located with the test runner; the radio is on an ESP32 elsewhere |
| **MCP over HTTP** | service had to sit adjacent to hardware | same — nothing forces a network-reachable service any more |
| **pm2** | Node process manager | not a Node process any more; a `uv` script has no need of one |

Mike's framing, quoted because it is the whole argument in one sentence:

> "since btleplug sucked less than noble i figured land on rust, but now that we left btleplug
> behind that's superseded."

**Corollary that is easy to miss:** the Rust decision was never about Rust. It was about *escaping
Noble*. Once the BLE stack is a remote ESP32 reached over TCP, no local BLE library is in the
picture at all, and the language choice reverts to "what has the best ESPHome client?"

---

## How "we left btleplug behind" was actually reached

The table above takes leaving btleplug as a **premise**. It was a **result**, and the way it was
reached carries weight the premise framing throws away.

**The ESPHome experiment was run to decide between two live options: replatform, or finish
stabilizing the btleplug implementation.** It was not a last resort tried after the local-radio path
had exhausted itself. btleplug was still a candidate on the day the experiment started, and the
experiment existed to choose between them. ESPHome won on its results, and *that* is what retired
btleplug.

So the alternative on the table was never "keep suffering with Noble" — it was **finish the option
that was already less flaky.** Any retelling in which the replatform was the only thing left to try
understates the evidence behind this decision.

**Two facts about the state btleplug was left in, both hidden by the "sucked less than Noble"
framing:**

- **It was less flaky than Noble, and its connection lifecycle was never finished.** It is a partial
  success abandoned mid-work, not a second failure. *"Why not just use btleplug?"* therefore has a
  real answer rather than a dismissal: it was better and incomplete, and the comparison was settled
  before the remaining work was done.
- **The hard part was connection lifecycle, and it still is.** ESPHome did not dissolve that
  problem — it moved it somewhere it is solved once, in this bridge, rather than being re-solved
  against every local BLE binding. The single writer slot, release completing only when the server
  processes the socket close, `BLE_DISCONNECT_TIMEOUT_S`, and the measured reconnect cooldown are
  all that same problem in the place it now lives.

### Why no better host was ever going to rescue the local-radio path

**Noble was flaky in every environment it ran in. The environment changed how bad it was, never
whether it was bad.** Mike, stating it in one line: *"noble was always flaky. just less flaky with
dedicated hardware."*

| what was changed | result |
|---|---|
| an arbitrary USB adapter → one chosen for known stability (Asus BT500) | still flaky |
| incus container and VM → a bare-metal dedicated host | **marginally** better, still flaky |
| Noble → btleplug | less flaky; lifecycle never finished |
| **the host BLE stack entirely → ESPHome proxy over TCP** | **fixed** |

The first two rows are the load-bearing ones, because they are the rows people re-propose. **Host-side
variables were tried and were never the ones that mattered** — which is why "give the container a USB
dongle" and "run it on dedicated hardware instead" are both closed questions rather than untried
ideas. Only the last row changed the outcome, and it is the only one that removes the host's BLE
stack rather than swapping a part of it.

---

## Evidence: the ESPHome client is the only load-bearing dependency

Everything else in this server is commodity — a WebSocket relay, a ring buffer, some JSON. The one
thing that is genuinely hard to own is the ESPHome Bluetooth Proxy client. That, and only that,
should decide the language.

### Rust — `esphome-native-api` 3.0.0 is not a Bluetooth Proxy client

Prost-generated structs plus a single public `start()`. No `bluetooth_device_request`, no GATT
write, no service-discovery aggregation, no error demux. Sole owner, 14 stars, **zero reverse
dependencies**, self-declared WIP — and its actual purpose is the *opposite direction*: UbiHome
emulating an ESPHome device for Home Assistant.

This explains a fact already in the repo: `rust-ble-test/src/` hand-rolls ~858 lines of protocol.
That was not extending a client, it was **writing one**. `api.proto` is 171 messages, 34 of them
Bluetooth (~20%), revved roughly monthly. Hand-rolling means owning that indefinitely.

### Python — `aioesphomeapi` is *the* client

`aioesphomeapi` 45.13.1 (published 2026-08-21), maintained by the ESPHome org / Nabu Casa. It is
the client Home Assistant itself uses. 28 Bluetooth methods, full GATT coverage, **typed GATT
errors** — a rejected write raises `BluetoothGATTAPIError` rather than timing out — and Cython hot
paths.

`bleak-esphome` 4.0.0 then provides `class ESPHomeClient(BaseBleakClient)`, making the proxy a
transport swap underneath **Bleak**, Python's standard BLE abstraction. Consequence worth stating:
a local radio would come back *free* if ever wanted, without a second implementation.

### Node — `@2colors/esphome-native-api` fails on exactly our two wounds

~80% complete, solo-maintained, 6 months stale. Its two known defects are precisely the two bug
classes fixed today:

1. **No `BluetoothGATTErrorResponse` handling** — a rejected write hangs 5s then throws a generic
   timeout, discarding the real error code. That is #583, one layer down.
2. **No `(address, handle)` correlation** — resolves on the first response from any device or
   handle. That is TRA-1154, one layer down.

Adopting it means re-fixing both in someone else's library and owning them there. This is the
strongest single argument against the "just consolidate on Node" position.

---

## Capability: the current server cannot run in this container as configured

**Placed here, not first — and stated precisely, because an earlier draft overstated it.** The
ESPHome-client comparison above is the independent, unchallenged argument and carries first
position. This one is real but qualified.

**Measured, from inside the container:**

- `/proc/self/uid_map` reads `0 1000000 1000000000` — mssb is an **unprivileged, user-namespaced**
  container.
- Opening an `AF_BLUETOOTH` socket fails with **errno 97, "Address family not supported by
  protocol."** `systemctl is-active bluetooth` returns `failed`.
- `/sys/class/bluetooth/hci0` *appears* to exist but is hollow — no `address` attribute. Visible in
  sysfs, not a usable adapter.
- The host (`k8s-alpha`) has a working `hci0` with the Bluetooth service **active**; the container
  has `security.privileged` empty, `security.nesting: true`, and **no devices passed through.**

**Why it fails is structural for unprivileged containers specifically:** the Linux Bluetooth
subsystem is **not network-namespace aware**, so a BLE socket inside a user-namespaced container
cannot reach the host stack. That is exactly the errno 97 observed.

**The precise claim, replacing an earlier absolute:**

> The TS server cannot run in this container **as configured**, and making it run requires
> `security.privileged: true` — dropping user-namespace isolation on a dev box — plus device access,
> plus sharing the host's single adapter. Whether it would then be **stable is unknown**; prior
> evidence of passthrough instability concerns a USB dongle into a container and a VM, which is
> related but not identical to using the host's built-in adapter from a privileged container.
> **The Python/ESPHome server runs unprivileged, with no radio at all.**

That is weaker than "structurally unrunnable" and stronger than "inconvenient." It remains a
capability argument — nothing you can configure makes the TS server as deployable as the Python one
— but it **must not be quoted as an absolute** at a decision.

**Open, and assigned to review:** would a privileged container with the host's `hci0` actually give a
working, *stable* BlueZ path, or does the prior passthrough instability apply there too? Neither
author has answered this.

Separately and not in dispute: **knuckles is powered off**, so the machine that could run this
repo's ~10 device-present tests is gone. That subset is currently unexecutable regardless of how the
container question resolves.

**On the CI rig** — with a local-radio bridge you buy a machine *and* colocate hardware next to it;
with an ESPHome bridge the runner needs only a TCP route, RF proximity moves to a ~$10 ESP32, and the
runner may be a container with no Bluetooth stack. **ESPHome-only is a prerequisite for unattended
hardware CI** — necessary, not sufficient; see Hazard 4.

**Whose CI, though — Mike's correction.** The unattended rig exists to run **platform's
application-level e2e** (`inventory.spec.ts` and friends), not this repo's transport suite. The
retirement enables the rig; the rig serves the other repo. Do not justify the rewrite by benefits
that land elsewhere — it does not need them.

---

## Counterarguments, and why each fails

| Argument | Why it fails |
|---|---|
| "Node consolidates to one language" | False premise. The mock is a **client**, the bridge is a **server**; they are already loosely coupled across a defined WebSocket protocol. Python server + TS client is *exactly as consolidated* as Node server + TS client. |
| "npm-native distribution protects adopters" | There are no adopters. ~1 year public, **zero stars, <1k lifetime downloads**. This is internal tooling. |
| "One artifact, one version prevents mock/server skew" | That coupling is already unused. platform consumes exactly **one file** — `dist/web-ble-mock.bundle.js` via symlink. It never imports the package in source, never invokes the `start-server` bin, and the bridge it actually runs is a locally-built Rust binary that was never published. |
| "Python runtime overhead" | Does not bind. Workload is ~45 msg/s. This project already measured the mock's per-packet `JSON.parse` at **0.03% duty** and retired it as a dead hypothesis; Python lands near 1%. Two orders of magnitude of headroom. |
| "pip packaging hassle" | `uv`. Already installed here (0.8.15, Python 3.12.3). Mike: *"i always reach for it first and use it wherever and whenever possible."* |

---

## MCP: a generation change, not drift — and a timing argument

**Attribution and confidence:** the spec facts in this section come from platform's research, dated
2026-07-28, and are **past this author's knowledge cutoff — not independently verified here.** The
repo-local facts below them *are* verified. Treat the spec claims as needing one confirmation before
anything is built on them.

Per that research, MCP was re-architected on **2026-07-28**, and it is a generation change rather
than drift: a stateless core (no `initialize` handshake, no `Mcp-Session-Id`, no GET/SSE stream, no
server-initiated requests), `server/discover` as a mandatory RPC, a required `resultType` on all
results, mandatory `Mcp-Method` / `Mcp-Name` headers, required `ttlMs` / `cacheScope` on list
endpoints, MRTR replacing server-initiated flows, and Roots / Sampling / Logging deprecated. Both
SDKs went 2.0 in the same week (TypeScript 2026-07-27 under new package names; Python `mcp` 2.0.0 on
spec day, Tier 1, LF-Projects-maintained).

**The consequence for this repo is sharp:** `StreamableHTTPServerTransport` in SDK v1 implements the
session-based 2025 shape that 2026-07-28 *removed*. Being on "the modern transport" was true last
month and is not true now.

**Therefore the MCP surface needs a protocol rewrite in either language.** That is a timing
argument, and it is the reason the language question is unusually cheap to ask right now: the work
that would be thrown away by switching languages is work that has to be redone anyway.

Three repo-local items, all verified today, all of which the rewrite should fix rather than port:

1. **Binds `0.0.0.0`.** `src/mcp-http-transport.ts:251` and `src/start-server.ts:19`. Local servers
   SHOULD bind `127.0.0.1`, and now that the bridge is co-located with the runner, the wide bind is
   gratuitous rather than necessary.
2. **No Origin validation, and CORS is wide open.** `src/mcp-http-transport.ts:23` sets
   `origin: '*'` with the comment *"Allow all origins on local network"*. Origin validation is a
   MUST for Streamable HTTP. A static bearer token is explicitly fine (authorization is OPTIONAL;
   for local servers the spec RECOMMENDS a token or unix sockets) — the missing Origin check is the
   actual defect, not the token.
3. **Tools return prose.** No `outputSchema` or `structuredContent` anywhere in `src/mcp-tools.ts`;
   every tool returns `type: 'text'`. `structuredContent` / `outputSchema` is the highest-value
   addition for `get_logs` and `get_connection_state`.

Note item 2 is largely *deleted* rather than fixed by the stdio split — a unix socket has no Origin
and no CORS.

---

## Resulting architecture

**Bridge is a test fixture, not a service.** Started and stopped by whatever runs the tests. No
systemd unit shipped; supervision is the user's business. platform's `playwright.config.ts` already
has a `webServer` hook for exactly this.

**Split the long-running bridge from a thin stdio MCP process, over a unix socket.** One argument
survives for this split and it is sufficient: in development, Claude Code sessions come and go while
the bridge must not. A single stdio process would cycle the hardware connection out from under
whoever holds it. **CI needs no MCP at all.**

**What that deletes:** the entire HTTP surface — Express (`src/observability-server.ts:1,70,73`),
CORS, `BLE_MCP_HTTP_TOKEN` (`src/start-server.ts:48`), MCP session management, and the port. It also
*removes rather than fixes* the `stdioEnabled = hasTty && !stdioDisabled` gotcha at
`src/mcp-http-transport.ts:225-227`.

**Lifecycle:** PEP 723 single-file script for the stdio MCP process; `pyproject` + `uvx` for the
bridge.

---

## Port accounting (measured, and corrected)

Measured from `src/` today, 30 `.ts` files:

| Bucket | Lines | Notes |
|---|---:|---|
| **TOTAL `src/**/*.ts`** | **5437** | |
| Mock — stays TypeScript | 833 | `mock-bluetooth.ts` 814 + `mock-browser-entry.ts` 19 |
| Node client — stays TypeScript | 843 | `src/node/`, 7 files — **see below** |
| Deleted outright | 737 | `noble-transport.ts` 413 + `rust-transport.ts` 324 |
| **Mechanical port to Python** | **3024** | |

Two corrections to the figures circulated earlier:

1. **The total is 5437, not 4616.** The lower figure silently omitted `src/node/`.
2. **`src/node/` (843 lines, 7 files) needs an explicit decision, and it was never stated.** It is
   a *client* library — a Web-Bluetooth-shaped API for Node consumers — so by the same logic that
   keeps the mock in TypeScript, it stays in TypeScript. It also carries 28 tests
   (`tests/unit/node-client.test.ts` 17, `tests/integration/node-client.test.ts` 11), a large share
   of the suite. Stating this explicitly is what makes the ~3042 port estimate correct rather than
   accidentally correct.

**MCP surface: 860 lines** across `mcp-tools.ts` (374), `mcp-http-transport.ts` (279),
`observability-server.ts` (207) — trivial as FastMCP decorators. **7 tools**: `get_logs`,
`search_packets`, `get_connection_state`, `status`, `get_metrics`, `scan_devices`,
`restart_rust_bridge`. Note the last one **disappears with the Rust bridge** — so it is 6 ports and
1 deletion.

---

## Concurrency: single writer, multiple read-only observers

**Decision:** the Python bridge grants the command path to **exactly one client**. A second attempt
to claim it is **rejected loudly**, with a distinguishable error — never silently queued, never
silently shared. Additional clients may attach **read-only** to the notification stream.

**Why the observer role exists rather than a plain lock:** what platform actually uses the mock for
is the user-gesture bypass *and* access to the transport stream to debug unexpected reader
behaviour. A pure single-client lock blocks that legitimate second use; unrestricted multi-client
permits the dangerous one. Single-writer / multi-observer is the shape that serves the stated need
without the hazard.

### What the two existing bridges actually do (verified)

| | Guard | Evidence |
|---|---|---|
| TS / Noble | **Session-level only** | `session-manager.ts:51-56` `findActiveSession(excludeSessionId)` finds any *other* session with `hasTransport`; `:71-75` returns `null`. Surfaces as `"Device is busy with another session"` (`bridge-server.ts:116`) |
| Rust | **None** | `main.rs:141-144` — bare `while let Ok((stream, _)) = ws_listener.accept().await`, cloning `cmd_tx` and calling `accept_transport.subscribe()` per connection, with no busy check in the accept path |

So single-client blocking was never *removed*; the Rust spike simply never implemented it. Because
the Rust bridge is what actually runs, **the protection is absent in practice while still present in
the code nobody runs.**

### The guard is weaker than "single client" even in TypeScript

This is the part that changes the requirement, and it is why the ADR specifies the ownership unit
explicitly rather than saying "restore the old behaviour":

- `ble-session.ts:18` holds `private activeWebSockets = new Set<WebSocket>()`, and `:97`
  `addWebSocket(ws)` adds to it. **Multiple WebSockets per session are a designed feature**, and
  they all share one transport with full write access.
- The guard therefore rejects a *different* `sessionId`. It has never protected against multiple
  writers sharing *the same* `sessionId`.
- And the test harness pins one: `tests/shared/test-config.ts` sets
  ``sessionId: `ble-mcp-e2e-${os.hostname()}` `` — fixed per host. So **every test client on a host
  shares one session, with shared write access, by default.** Shared-writer is the normal
  configuration here, not an edge case the guard catches.

Both sides pin a fixed per-host session id, so this is symmetric rather than a quirk of one harness:

| repo | file | session id |
|---|---|---|
| ble-mcp-test | `tests/shared/test-config.ts:15` | `` `ble-mcp-e2e-${os.hostname()}` `` |
| platform | `tests/config/vite-bridge.config.ts:37` | `` `trakrf-handheld-dev-${systemHostname}` `` |

**Requirement for the port: ownership is per-CONNECTION, not per-session.** Restoring the
TypeScript behaviour verbatim would reproduce a guard that never covered the common case — it would
feel like a fix and change nothing.

**Corollary, and it corrects a natural assumption:** the same-bridge hazard is *not* a Rust
regression. It would be equally quiet under the TypeScript bridge, because same-session sharing is
by design there and the guard only ever rejected a *different* session id. The Rust bridge is worse
— it doesn't reject even that — but the hazard we actually care about predates it and lives in the
implementation we were treating as the good example.

### The concrete form of the risk

The thing someone would actually do: **open a second tab on `localhost:5173` to watch what the app
is doing while a soak runs.** Same host, same pinned session id, mock injected, full write access —
two clients commanding one reader through one `CommandManager` that matches no op codes.

Note the specificity: `localhost:5173`, **not** the deployed build. The deployed build uses native
Web Bluetooth with no mock, so a second viewer there lands in the loud radio-level case above. **The
dangerous path is the debugging path** — which is exactly the path the observer role is meant to
serve, and the reason it must be read-only rather than merely discouraged.

### Why this compounds — do not treat it as cosmetic

It multiplies with **TRA-1154**: `CommandManager` has no op-code correlation and settles the pending
command with whatever command-class packet arrives. Add a second writer on the same physical reader
and you get exactly that mis-resolution — client A's response settling client B's pending command.
Two independently survivable gaps that are dangerous together.

### Why interference is mostly self-announcing today, and where that stops

The CS108 is single-connection **at the radio level**. If someone pairs natively while the bridge
holds the link, the bridge simply cannot connect and the run dies at `connectToDevice` — demonstrated
live: with cell A holding the link, a native pair attempt scans and finds nothing.

That covers only the *native* case. The *same-bridge* case is quiet today precisely because the Rust
bridge lost the guard — which is the gap this decision closes.

**Caveat for the unattended rig:** an empty device selector is loud but **not diagnostic**. "Nothing
here" covers someone-else-holds-it, reader-off, reader-asleep and out-of-range identically. This is
where the never-populated `battery` column returns: at 3am, a discharged reader and a claimed reader
produce the same silence. Distinguishable errors matter more without a human in the room.

---

## Hazards

These cluster on wounds this project already has, which is why they are called out rather than left
to code review.

**1. `EventEmitter` → asyncio.** The code leans on `this.once('message.X', handler)`. Python needs
Futures / Events / Queues, and each translation is a lifetime-and-cancellation judgement. A sloppy
one recreates *"listener never fires, caller waits out the timeout"* — TRA-1154 and #583 in a new
language.

**1a. The recurring failure class: a waiter whose condition cannot be satisfied by what is actually
sent.** Four instances in this codebase family, all found on one day:

| Instance | Shape |
|---|---|
| #583 | write failures produced silence; the caller waited out the timeout |
| TRA-1154 | no op-code correlation; a stray packet settles the wrong command |
| `@2colors` ESPHome client | no GATT error handling; a rejected write hangs 5s, then a generic timeout |
| `cleanup_complete` | the wait tests a message name the server never sends |

Every one fails **as a timeout rather than as an error**, which is why none were caught by
inspection. This is an architectural failure mode, not four coincidences.

**Design rule for the port:** every request/response pair must have its **wait condition and its
emitter checked against each other mechanically** — a test, or a shared constant both sides derive
from — never by eye. Eyeballing has now missed it four times.

**The fifth instance is different in kind, and the distinction matters.** `aioesphomeapi`
(`connection.py:1184-1192`) catches every handler exception and routes it to `_LOGGER.exception`,
explicitly so a buggy callback cannot tear down the session (their issue #1755). **That is correct
upstream design, not a defect** — but the consequence is that *our* notify-path exceptions vanish
into their logger.

So the four above are "mistakes to avoid"; this one is **a correct upstream decision that transfers
the obligation to us**. The bridge must surface notify-path errors *deliberately, from inside the
callback*. Nothing upstream will do it, and nothing will fail loudly if we forget — which is the same
silence, arrived at from the opposite direction.

**2. asyncio swallows exceptions.** A `Task` whose exception is never retrieved logs at GC time, or
never. That is literally the failure-becomes-silence class this project keeps rediscovering.
**Standing rule: every task is awaited or given an explicit done-callback.** No exceptions.

**3. Backpressure.** `ws` and `websockets` treat slow consumers differently. Irrelevant at 45 msg/s,
decisive at firehose rates — which is exactly what the first milestone tests.

**4. The WebSocket protocol is the real contract — and it is SMALLER than this ADR first claimed.**
The e2e suite is written against the TS bridge's protocol, and the Rust bridge implements two message
types (`connected`, `data`). That gap — not performance, not language — is why the Rust bridge never
replaced the TS one and why `session-management.spec.ts` cannot pass against it. The hazard is real.

**Correction to this ADR's earlier claim of "13 message types."** The count was right by accident and
the membership was wrong: `characteristicvaluechanged` is a DOM `CustomEvent` inside the mock, not a
wire message; `disconnected` is synthesized client-side in the socket's `onclose` handler and never
crosses the wire; `ack` was missing from the list. **Nine message types actually traverse the wire,
and two request/response pairs among them are dead on both ends** — so the port implements seven.

The contract is now specified properly in **`2026-08-23-ws-protocol-spec.md`**, which supersedes the
count as the acceptance criterion. Treat *that document* as the criterion — a number was never
implementable.

---

## Sequencing

1. **Firehose stress test first** (Mike's proposal). Injected notifications, field-free, validates
   the language choice at rate *and* leaves a regression net before any rewrite begins.
2. **Bridge + WS relay** — to the full 13-message protocol above, not a subset.
3. **The bridge/MCP split** over a unix socket.
4. **MCP last**, since it has been effectively unused anyway.

---

## Open questions

1. ~~**`bleak-esphome`'s NOTIFY path needs reading before commitment.**~~ **RESOLVED** — see
   `2026-08-23-bleak-esphome-notify-audit.md`. The path is sound: correlation is explicit
   per-`(address, handle)` (`client_base.py:172`), there is no queue so a slow consumer produces
   backpressure rather than unbounded growth, subscriptions cannot outlive their connection because
   the handler registry lives on the connection object, and handler exceptions are caught and logged
   rather than swallowed. Two of this project's recurring bug classes — TRA-1154's correlation gap
   and 3f7eefb's stale-transport events — are handled *better* there than in our current code.

   One constraint falls out: **the notify callback runs synchronously on the event loop**, so
   non-trivial per-notification work must go behind the bridge's own queue. Throughput was reasoned,
   not measured; the firehose test settles it.
2. **Confirm the 2026-07-28 MCP re-architecture independently** before building on it. See the MCP
   section — those claims are second-hand and past this author's cutoff. The decision does not rest
   on them (the ESPHome client comparison and the unrunnable-server argument stand alone), but the
   *sequencing* does: if MCP genuinely needs a protocol rewrite in either language, MCP-last is
   correct and switching languages costs nothing there.

   Separately, a defect that exists **today**, independent of the rewrite and of that research:
   `package.json` declares `"@modelcontextprotocol/sdk": "^1.0.4"` while the lockfile resolves
   **1.17.0**, and `StreamableHTTPServerTransport` (imported at `src/mcp-http-transport.ts:4`) **did
   not exist at 1.0.4**. The declared floor is not merely stale — it is *false*, and a clean install
   honouring it could not work. The manifest lies about what the code needs. One-line fix, worth
   doing now rather than waiting for the rewrite.
3. **Does the Node client (`src/node/`) still earn its place?** Kept in TypeScript by this ADR, but
   it has no known consumer. Worth a separate look rather than a silent port or a silent deletion.

---

## Dependencies & references

- Supersedes: PR #41 (`feature/rust-ble-bridge`), the Rust bridge direction.
- Subsumes: **TRA-1155** (btleplug retirement) — reframed from hygiene to premise change.
- Related: **TRA-1154** (op-code correlation, platform), **#583** (write-failure visibility,
  platform) — both are the bug classes the Node ESPHome client would reintroduce.
- Related: `docs/design/2026-08-23-mock-lifecycle-realignment.md` — the mock side, unaffected by
  this decision.
- Identifiers in this document are masked past the OUI per house rule.
