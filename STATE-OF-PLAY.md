# State of Play — 2026-08-21

Factual assessment of where this repo stands after a long period of use-and-hope,
plus the results of an adapter evaluation run the same day.

Assessed from branch `feature/rust-ble-bridge` @ `850d3c6`.

---

## 📋 HANDOFF — read this first

Written at the end of the assessment/eval session, before a model switch to Fable
for design work. **Sections 1-12 are findings; this block is orientation.**

### Machine state as left

| | |
|---|---|
| Adapter bound | **ASUS dongle only** (`hci0`, Realtek). Intel unbound from `btusb` |
| Bridge | PM2 `ble-mcp-test` **online**, connected to CS108, passing traffic 100 % |
| Last health check | 11/11 commands, 0 timeouts, 0 new panics |
| Stray processes | none |
| Restore both radios | `./scripts/select-adapter.sh both` |

**⚠️ Not persistent.** `btusb` bind does not survive a reboot. After any reboot both
radios return and `main.rs:343` (`adapters.nth(0)`) picks arbitrarily — possibly the
Intel radio, which does **not** recover from disconnects. Check with
`./scripts/select-adapter.sh status` before trusting any result.

### What was decided

1. **Use the ASUS dongle.** 10/10 disconnect recoveries vs Intel's 0/2; 100 % vs 0 %
   on an identical functional check minutes apart. Full evidence in §11.
2. **No hardware purchase.** No `btrtl` driver problems appear in `dmesg`. The
   AX211 is *incompatible* with this box (CNVio2, needs 12th-gen+ CPU); the AX210
   would work but answers no open question. Revisit only if a long soak surfaces
   RTL symptoms.
3. **Root cause of the crash-loop found** (§5.0d): a one-line `unwrap()` in
   `bluez-async-0.8.2/src/messagestream.rs:40`, fired on **disconnect**. Not fixed
   upstream, and `btleplug 0.12` still pins the same version.

### Suggested first moves for design

Ordered by value-to-risk. The first two are cheap, touch no BLE code, and unblock
diagnosis of everything else:

1. **Stop treating Rust stderr as fatal** (`rust-transport.ts:87`). It matches the
   substring `'Error:'` and kills the whole Node process for a panic the Rust
   process survives (`panic=unwind`; tokio catches task panics). §5.0b/§5.0d lever 1.
2. **Stop discarding Rust stdout** (`rust-transport.ts:76-79`). Every diagnostic
   `main.rs` prints is parsed for packet bytes then thrown away. This is why we
   cannot tell whether Intel's `full_reconnect_cycle` ran and failed or never
   fired. §5.0 correction block.
3. **Pin adapter selection** — replace `adapters.nth(0)` with an env var or
   BD-address match. Closes the reboot risk above.
4. Then the larger architectural questions in §12.

### Governing constraint

Session stability must not regress (§1) — trakrf platform E2E depends on it. The
steady-state path is a baseline to protect, not to refactor freely. Recovery work
is additive.

### Tooling built this session (uncommitted)

- `scripts/ble-soak.js` — 4 modes: `poll`, `thrash` (write pressure),
  `inventory` (tag-stream flood), `recover` (induced HCI disconnects). §10.
- `scripts/select-adapter.sh` — `asus` / `intel` / `both` / `status`.
- `tmp/soak/*.json` — seven result files from the eval.

**Not yet run:** a multi-hour soak on the Realtek to build the missing long-duration
evidence base (we have ~90 min total). Mike will suggest it after the model switch.

### Corrections made during the session — do not re-derive

- The claim "in-process recovery paths never executed in production" was **wrong
  and withdrawn** — it was inferred from log absence that the plumbing guarantees.
- "Deployed binary may not match `main.rs`" was **resolved: it does match**
  (verified with `strings`).
- "Realtek drivers are weaker than Intel" was **contradicted by measurement** here.
- The Intel-vs-ASUS A/B is **generation-confounded** (2015 Intel 3165 vs modern
  Realtek). It justifies the adapter choice, not a general claim about `btintel`.

---

## 1. Why the Rust work exists, and what it achieved

This is the context that is **not recoverable from the code or git history**, and it
should be read before anything below.

**The problem it was solving:** Noble.js session stalls. Sessions would hang after
seconds to minutes and require a hardware reset and/or a BlueZ stack restart to
recover. The bridge would rarely survive a single meaningful E2E test session.

**What the Rust spike achieved:** it worked. Since the spike, the link **stays
connected and responsive ~99% of the time.** The core motivation — connection
stability under sustained use — is met, and this is the main reason the branch
exists and matters.

**What is still broken:** **disconnect and recovery.** Once the link does drop, the
bridge does not come back on its own. Section 5 documents the concrete mechanisms.

Sections 4 and 5 below list defects and regressions. They are scoped to the spike's
*unfinished edges* — they are not an argument against the Rust direction, which is
carrying its weight on the problem it was built for.

### The governing constraint

**Session stability as achieved by the Rust spike is the highest priority and must
not regress.** It is what makes automated E2E testing from the **trakrf platform
repo** viable, and that is critical to that project. The bridge is not a standalone
concern — it is load-bearing infrastructure for a downstream consumer.

Practical consequences for any plan that follows:

- The ~99% stable connected path is the **baseline to protect**, not a starting
  point to refactor freely. Changes to the Rust connect/serialize path carry real
  risk and need to be justified against that.
- Recovery work (section 5) is **additive** — it addresses what happens *after* a
  drop. It should be possible to do most of it without touching the steady-state
  path that currently works.
- Reverting to Noble, or any plan that routes the steady-state data path back
  through `noble-transport.ts`, is off the table: that is the exact failure mode
  the spike eliminated.
- There is currently **no regression test for stability itself** — no soak or
  long-duration test that would catch a reintroduced stall. Given the constraint,
  that gap is worth noting early.

## 2. Release / publish status

| Thing | State |
|---|---|
| npm `ble-mcp-test` latest published | **0.7.3** |
| `main` @ `975804e` (2025-09-11) | v0.7.3, all-Noble.js — **contains no Rust** |
| Rust work | `feature/rust-ble-bridge` only — pushed to origin, **not merged, no PR** |

**Nothing Rust-related has ever been published or merged to main.** The published
package and `main` are consistent with each other. The awkward interim state is
confined to the local working tree and unmerged branches.

Note the implication: `main` and npm 0.7.3 are the *Noble* build — i.e. the version
with the stalling problem that the spike fixed.

## 3. Branch inventory

| Branch | Head | Date | vs main | Status |
|---|---|---|---|---|
| `main` | `975804e` | 2025-09-11 | — | Released as 0.7.3 |
| `feature/rust-ble-bridge` | `850d3c6` | 2026-01-20 | +2 commits, +2644/-62 | **Current checkout.** Rust spike |
| `fix/simplify-noble` | `5fb5224` | 2025-09-17 | +2 commits, +632/-144 | Abandoned. Lifecycle work + design doc |
| `fix/ble-instability` | `8b7e684` | 2025-09-17 | +2 commits, +488/-24 | Abandoned. Earlier cut of the same idea |
| `origin/feature/rpc-refactor` | `aeec6ba` | 2025-08-07 | +5 commits, +1259/-287 | Abandoned WIP. Forked from main 2025-08-06 |
| `origin/fix/noble-zombie-state-reset` | `5d4a4e7` | 2025-09-05 | already in main | Dead, can be deleted |
| `origin/fix/characteristic-refresh` | `60cf378` | 2025-09-08 | already in main | Dead, can be deleted |

Three branches (`simplify-noble`, `ble-instability`, `rpc-refactor`) are **parallel
abandoned attempts at overlapping problems**, never reconciled with each other or
with the Rust spike that was actually written.

## 4. What the Rust work actually is

Two commits, ~900 lines of new code. Structurally it is still a **spike** — it proved
the thesis but was never finished into a migration.

### Components

**`rust-ble-test/src/main.rs`** — 557 lines, btleplug 0.11.8 + tokio-tungstenite.
Standalone binary. Scans 5s, finds a peripheral advertising the target service,
connects with exponential-backoff retry, subscribes to notifications, and serves
**its own WebSocket server on hardcoded `0.0.0.0:8080`**. Includes a
`ConnectionHealth` circuit breaker and a `full_reconnect_cycle` recovery path. All
BLE ops are serialized through a single tokio task (`main.rs:471-520`).

**`src/rust-transport.ts`** — 324 lines. Spawns that binary as a child process and
**parses its emoji stdout log lines with regex** (`📤 BLE write successful: [A7, B3…]`)
to reconstruct packet bytes for the MCP `LogBuffer`. Also owns subprocess
auto-restart with backoff, and `pkill -f rust-ble-test` / `lsof -ti:8080 | xargs kill`
cleanup.

**Supporting wiring:** `mcp-tools.ts` gains a `restart_rust_bridge` MCP tool;
`observability-server.ts` gains `setRustTransport`/`getRustTransport`;
`.gitignore` gains `**/target/`; `pre-test-cleanup.js` learns not to kill the
production Rust process.

### The structural change

`src/start-server.ts` **no longer starts `BridgeServer` at all** (`start-server.ts:56`,
the `bridgeServer.start()` call is deleted). The Node process now only runs MCP
observability on 8081; Rust owns 8080.

That orphans the entire Node bridge stack — still compiling, wired to nothing:

| File | Lines | Status on this branch |
|---|---|---|
| `src/bridge-server.ts` | 199 | orphaned |
| `src/session-manager.ts` | 271 | orphaned |
| `src/ble-session.ts` | 215 | orphaned |
| `src/ws-handler.ts` | 207 | orphaned |
| `src/noble-transport.ts` | 413 | orphaned |

## 5. Why disconnect and recovery don't work

### 5.0 What actually happens in production — read this first

§5.1–5.5 below are *static analysis of the source*. The PM2 logs in `logs/`
(2025-08-07 → 2026-08-21, ~230 MB) show the **observed** failure is different, and
this distinction should drive priorities.

**The dominant, recurring production failure is a panic inside btleplug's D-Bus
layer — not any of the recovery logic below.**

```
thread 'tokio-runtime-worker' panicked at
  bluez-async-0.8.2/src/messagestream.rs:40:84:
called `Result::unwrap()` on an `Err` value:
  D-Bus error: No match with that id found (org.freedesktop.DBus.Error.Failed)
```

This exact signature recurs across **eight months**: 2026-01-22, 05-23, 07-29,
07-30, 08-07, 08-20, and **2026-08-21 11:54 — roughly 90 minutes before this
assessment was written.** It is the current, live failure.

A second variant kills the **Node** process too, not just the subprocess:

```
Error: Other(DbusError(D-Bus error: Method "GetAll" with signature "s" on interface
  "org.freedesktop.DBus.Properties" doesn't exist (org.freedesktop.DBus.Error.UnknownObject)))
→ Fatal error … at dist/rust-transport.js:60
```

Aggregate counts across `logs/*.log`:

| Signature | Count | Source | Meaning |
|---|---|---|---|
| `Rust bridge exited` | 300 | Node | subprocess died |
| `Auto-restarting` | 268 | Node | Node restarted it |
| `Rapid failure detected` | 26 | Node | died again within 10s |
| `BLE write failed` | 250 | Node | |
| ~~`Full reconnect cycle`~~ | ~~0~~ | Rust stdout | **not measurable — see below** |
| ~~`Circuit breaker open`~~ | ~~0~~ | Rust stdout | **not measurable — see below** |

> **⚠️ CORRECTION (later in the same session).** An earlier version of this document
> concluded from those zeroes that "the in-process recovery paths have never
> executed in production." **That conclusion was wrong and is withdrawn.**
>
> `rust-transport.ts:76-79` pipes the Rust subprocess's **stdout** into
> `parseRustOutput()`, which extracts packet bytes and one connection marker and
> **never echoes the raw lines**. Only **stderr** is echoed
> (`rust-transport.ts:84`). Every diagnostic `main.rs` prints to stdout —
> `✅ Connected on attempt`, `🔄 Full reconnect cycle starting`,
> `🔍 Rediscovering services`, `❌ BLE write failed` — is **silently discarded
> before it can reach a log file.** Their absence is guaranteed by the plumbing and
> says nothing about whether the code ran.
>
> Verified: `strings` on the deployed binary contains all of those messages, so the
> binary does match `main.rs` — the messages are being swallowed, not missing. This
> also resolves the "deployed binary may not match source" caveat raised below:
> **it does match.**
>
> The Node-sourced counts in the table above remain valid — those go through
> `console.log`/`console.error` and do reach the logs. So does the panic count,
> since panics go to stderr.

**This is itself a significant finding.** The observability layer discards the
bridge's own diagnostics. During the §11 recovery testing the bridge demonstrably
*did* reconnect — 10 out of 10 induced disconnects, ~5.5 s each — and not one line
of evidence for that appears in any log. Anyone debugging a future failure is
flying blind on everything the Rust side has to say.

**Revised ordering.** The panic remains the highest-value fix (§5.0d), but the
justification is the live crash-loop reproduced in §5.0b, not the retracted
"recovery never runs" claim. The §5.1–5.5 defects should be treated as **unverified
static analysis** — plausible from reading the source, but not confirmed to fire,
and §11 shows at least the reconnect path working correctly on `hci0`.

**Caveat worth resolving:** `Connected on attempt` (printed by `connect_with_retry`
on every success, `main.rs:89`) appears **0 times** in the logs despite traffic
flowing. That suggests **the deployed binary may not match the committed
`main.rs`** — the release binary is dated 2026-01-19, the path-fix commit 2026-01-20.
Confirm binary/source parity before trusting any source-level conclusion here.

### 5.0b Reproduced live, 2026-08-21 12:50

`pnpm pm2:start` was run during this assessment. The failure reproduced immediately
and repeatedly — **3 crashes in ~3 minutes**, PM2 restart counter 6 → 9:

```
12:50:07  🦀 Starting Rust BLE subprocess...
12:50:14  panicked at bluez-async-0.8.2/src/messagestream.rs:40:84   ← 7s later
          Fatal error: … at dist/rust-transport.js:60   → Node process exits
12:50:19  (PM2 restart) 🦀 Starting Rust BLE subprocess...
12:50:24  Error: Other(DbusError(… "GetAll" … UnknownObject))       ← 5s later
          Fatal error: → Node process exits
12:50:29  (PM2 restart) …
```

The BLE link *does* establish each cycle — the device's LED shows connected, and
`hcitool` caught the live link — before the panic kills it seconds later.

**The kill chain, now fully traced:**

1. btleplug/`bluez-async` panics on a D-Bus error during teardown/property access.
2. `rust-transport.ts:87` scrapes **stderr** and matches on the substring
   `'panic'` **or `'Error:'`** — then `this.emit('error', …)`.
3. `initialize()` registered `this.once('error', reject)` (`rust-transport.ts:146`),
   so that emit **rejects the initialize promise**.
4. `start-server.ts:61` does a bare top-level `await rustTransport.initialize()`
   with **no try/catch**.
5. The rejection reaches the `unhandledRejection` handler → `Fatal error:` →
   **the entire Node process exits**, taking MCP observability down with it.
6. PM2 restarts everything; repeat every ~10s.

**Two consequences worth separating:**

- The `'Error:'` substring match is far too broad — *any* stderr line containing
  `Error:` tears down the whole service, whether or not it is fatal to the bridge.
- Because Node dies at step 5, the subprocess auto-restart logic in the `'exit'`
  handler (`rust-transport.ts:94-132`) — the backoff, the restart counter, the
  `forceRestart()` path — **never executes at all.** It is unreachable in this
  failure mode, which is consistent with §5.0's zero-count evidence.

This also means the service-split premise from the SERVICE-SPLIT doc (§7) is
currently **inverted**: rather than MCP observability surviving a bridge crash, a
bridge crash reliably kills MCP observability too.

### 5.0d Root cause of the panic — found, and it explains the exact symptom

The panic is a **one-line bug in `bluez-async`**, btleplug's Linux backend:

```rust
// bluez-async-0.8.2/src/messagestream.rs:36-41
impl Drop for MessageStream {
    fn drop(&mut self) {
        let connection = self.connection.clone();
        let msg_match = self.msg_match.take().unwrap();
        tokio::spawn(async move { connection.remove_match(msg_match.token()).await.unwrap() });
    }                                                                        // ^^^^^^^^ panics
}
```

When a `MessageStream` is dropped it spawns a task to remove its D-Bus match rule
and **unwraps the result**. If the match is already gone — the peer disconnected,
BlueZ removed the object, the connection went away — `remove_match` returns
`Err(No match with that id found)` and it panics. Column 84 in the panic message
lands exactly on that `.unwrap()`.

**This fires on disconnect and teardown.** Which is precisely the reported symptom:
*stable while connected, ~99% of the time; the disconnect and recovery is what
doesn't work.* The disconnect path panics inside a dependency before any of the
bridge's own recovery logic (§5.1–5.4) can run. That is why those paths show zero
executions across eight months of logs.

**Upgrading will not fix it.** Verified:

- `bluez-async 0.8.2` is the **newest published version** — the bug is live upstream.
- `btleplug 0.12.0` (we are on `0.11.8`) **still pins `bluez-async 0.8.2`**.
- That `.unwrap()` is the only `remove_match` call site in the crate.

**But the panic should not be fatal, and currently is only because of our own code.**
`rust-ble-test/Cargo.toml` has no `[profile]` section, so the panic strategy is the
default `unwind`. A panic inside a `tokio::spawn`ed task is **caught by the runtime**
and surfaced through the `JoinHandle` — it does **not** abort the process. The Rust
bridge almost certainly survives this panic on its own.

What kills the service is `rust-transport.ts:87`, which scrapes **stderr** and treats
any line containing `'panic'` (or the substring `'Error:'`) as fatal → emits
`'error'` → rejects `initialize()` → unhandled at `start-server.ts:61` → whole Node
process exits (§5.0b).

So there are three independent levers, cheapest first:

1. **Stop treating stderr text as fatal** in `rust-transport.ts`. A survivable
   library panic currently causes a full service restart. This is the highest
   value-to-risk change available and touches no BLE code.
2. **Patch `bluez-async`** via `[patch.crates.io]` with a fork that logs instead of
   unwrapping. A genuine one-line fix, and upstreamable.
3. **Avoid the drop path** — hold `MessageStream`s for the process lifetime rather
   than letting them drop per-disconnect. Larger change, touches the working path,
   so it carries real risk against the §1 constraint.

Note that the *second* observed failure — `Error: Other(DbusError(… "GetAll" …
UnknownObject))` — is different: that one propagates out of `main` and genuinely
exits the Rust process. Lever 1 does not fix it, but it is far rarer in the logs.

### 5.0c The bridge is not using the adapter you think it is

Caught live while the link was up:

```
$ sudo hcitool -i hci1 con
    < LE 6C:79:B8:26:03:A7 handle 3585 state 1 lm CENTRAL     ← the CS108
$ sudo hcitool -i hci0 con
    (none)
```

**The bridge binds `hci1` — the NUC's built-in Intel BT 4.2 radio. The ASUS
BT 5.4 dongle (`hci0`) is idle and unused.**

This is the `adapters.into_iter().nth(0)` problem in §8 made concrete. The dongle
was originally added when USB pass-through to an Incus VM was being attempted; that
approach was abandoned in favour of dedicated hardware, but the dongle stayed
plugged in — and the bridge has silently been running on the *other* radio.

Two things follow, both cheap to act on:

1. **The ~99% stability figure was achieved on the Intel built-in radio**, and so
   were the D-Bus panics above. Any belief that the dongle is the more reliable
   part has not actually been under test.
2. **Forcing the bridge onto `hci0` is a near-zero-cost experiment** with a real
   chance of moving the panic rate, since it swaps both the controller and the
   kernel driver (Realtek `btusb` vs Intel) underneath the same BlueZ/D-Bus stack.
   Worth trying before any code change to the recovery logic.

### A logging trap that will mislead you

`ConsoleLogger.logEntry()` (`console-logger.ts:20`) hardcodes the string
`[WSHandler]` for **every** TX/RX entry, whatever produced it. `rust-transport.ts`
pushes its scraped packets through `logBuffer.push()` (lines 174, 186), which routes
to that same logger. **So Rust-bridge traffic is logged as `[WSHandler]`, making it
look like the Node bridge is running when it is not.** This mislabeling cost time
during this assessment; it is worth fixing early for the sake of the recovery work.

### 5.1–5.5 — static analysis of the recovery paths

Five concrete mechanisms, all verified against `main.rs`. They compound, so fixing
any one alone will not produce working recovery. Per §5.0, treat these as latent
rather than currently-firing.

**5.1 — The circuit breaker latches permanently. This is the terminal one.**

`ConnectionHealth::should_attempt_reconnect()` (`main.rs:68-70`) is
`!circuit_open || consecutive_failures < 10`. `record_failure()` sets
`circuit_open = true` at 5 consecutive failures. At **10** failures the guard returns
`false` — and `safe_write_with_recovery` then returns early
(`main.rs:166-171`) *before* reaching any code path that could call
`record_failure()` or `record_success()`. So `consecutive_failures` freezes at 10 and
`circuit_open` freezes at `true`.

`circuit_open` is only ever cleared by `record_success()`, which is only reachable
via a successful write, which the guard now refuses to attempt. **The state is
unrecoverable in-process and permanent.** Every subsequent write returns
`Err("Circuit breaker open - too many failures")` forever.

The Rust process does not exit in this state — it sits there, healthy from the
outside, answering nothing. And `rust-transport.ts` only triggers a restart on the
subprocess `'exit'` event (`rust-transport.ts:94`), which never fires. Neither layer
detects the wedge. The `restart_rust_bridge` MCP tool is the only escape hatch,
which is presumably why it was written.

**5.2 — Nothing detects a disconnect except an outgoing write.**

There is **no `CentralEvent` / adapter event stream subscription anywhere**
(verified: zero occurrences of `CentralEvent`, `central.events()`). btleplug's
`DeviceDisconnected` event is never observed. The only connection-state check is a
lazy `peripheral.is_connected()` poll inside `safe_write_with_recovery`
(`main.rs:174`).

Consequence: a drop is noticed only when the *next command happens to be written*.
An idle or notification-only link can be dead indefinitely with nothing noticing.

**5.3 — The notification stream is never re-acquired after a reconnect.**

`peripheral.notifications()` is called **exactly once** (`main.rs:473`), before the
BLE task's loop starts. `full_reconnect_cycle` re-subscribes to the characteristic
(`main.rs:151`) but never re-acquires the stream, and the loop keeps polling the
original `notification_stream`.

On the BlueZ backend that stream is bound to the D-Bus objects of the *previous*
connection, so after a reconnect it is stale. The result is the worst failure shape:
**a "successful" reconnect that reports connected, accepts writes, and is deaf** —
no device responses ever arrive again. (High confidence, but worth confirming
empirically against btleplug 0.11.8's bluez backend before designing around it.)

**5.4 — WebSocket clients are never told anything went wrong.**

Rust emits exactly two frame types to clients: one `{type:"connected"}` greeting
(`main.rs:258-261`) and `{type:"data"}` (`main.rs:315-318`). There is **no
`disconnected` and no `error` frame** — verified, those are the only two `"type"`
keys sent.

So a browser client's mock never observes a GATT disconnect, never fires
`gattserverdisconnected`, and has no signal to reconnect on. From the test's point
of view the connection is permanently healthy. Whatever recovery the Rust side does
or fails to do is invisible to the client.

**5.5 — The BLE link's lifetime is bound to the process, not to a session.**

Connection is established once in `main()` at startup, *before* the WebSocket server
is bound (`main.rs:402-449`). If the device isn't present at process start, `main`
returns `Ok(())` and exits (`main.rs:391`) — the WS server never starts at all.
There is no connect-on-client-request and no disconnect-on-last-client-leaving.

This is the architectural mismatch behind the lifecycle rework: BLE connection
lifetime is process-scoped, whereas BLE (and the Playwright use case) wants it
session-scoped.

**Also worth noting** — recovery stalls notification delivery. The single serialized
BLE task (`main.rs:483-519`) awaits `full_reconnect_cycle` *inside* one `select!`
branch, and that cycle sleeps 2s plus a cooldown of up to 30s (`main.rs:72-80`).
For that whole window the notification branch cannot be polled, so device responses
are not merely delayed but dropped from the client's perspective.

**Minor:** the backoff in `get_cooldown_duration` computes `2 << consecutive_failures`
on a default-typed `i32` (`main.rs:77`); at ≥31 consecutive failures the shift
overflows. Unreachable in practice given 5.1 latches at 10, but it is a latent bug
if the breaker logic is fixed without touching this line.

## 6. Other regressions introduced by the spike

Distinct from section 5 — these are capability losses from replacing the bridge
wholesale rather than recovery defects. All are silent at runtime.

- **Device agnosticism lost.** `main.rs:16-18` hardcodes the CS108 service/write/notify
  UUIDs as Rust `const`s. The `?service=&write=&notify=` URL params that
  `ws-transport.ts:38-42` still sends are ignored. This contradicts the
  device-agnostic premise in `CLAUDE.md`.

- **Session management lost.** Rust speaks only `{type:"data"}` plus one
  `{type:"connected",device:"CS108Reader2603A7"}` greeting (device name also
  hardcoded). The protocol `ws-transport.ts:3-18` defines — `session`, `token`,
  `eviction_warning`, `keepalive_ack`, `force_cleanup`, `cleanup_session`,
  `admin_cleanup` — is entirely unimplemented.

- **`rust-transport.sendCommand()` cannot work.** It writes JSON to the subprocess's
  **stdin** (`rust-transport.ts:238`); `main.rs` never reads stdin (verified: zero
  occurrences of `stdin`/`BufReader`/`read_line`). Nothing calls it, so it is dead
  rather than actively broken. Separately, `checkPendingResponses()`
  (`rust-transport.ts:201-213`) resolves the *first* pending command with *any*
  arriving notification — no correlation.

- **`scanDevices()` returns a hardcoded fake** — `[{id:'cs108', …}]`
  (`rust-transport.ts:242-247`). The `scan_devices` MCP tool therefore lies.

- **Write errors vanish.** `mock-bluetooth.ts` `writeValue` was changed to
  fire-and-forget; the `await` on transport send was removed.

- **Tests can no longer self-host.** `tests/test-config.ts` lost its
  start-a-local-BridgeServer fallback; every integration test now hard-requires a
  running PM2-managed server.

## 7. Prior design work that exists but was never reconciled

`docs/SERVICE-SPLIT-IMPLEMENTATION.md` exists in **two diverged versions** (445 lines
on `fix/ble-instability`, 466 on `fix/simplify-noble`; they differ by +87/-66 lines).
The `simplify-noble` version is the later one and already reframes the plan around Rust.

Its stated architecture differs materially from what the spike built. It specifies:

- Rust owning WS **including session management** (the spike implements none)
- Valkey/Redis as the shared state layer, so MCP observability and logs survive a
  bridge crash (the spike instead scrapes stdout into an in-memory `LogBuffer`)
- Rust writing state/logs to Redis, Node reading them

Its recorded rationale for abandoning Noble.js matches the lived experience in
section 1: HCI-layer corruption not fixable from userland, progressive "unknown
peripheral" states, session-reuse doom loops, and a claimed btleplug ~99.9% vs
Noble ~75% reliability in stress testing. The ~99% figure has since been borne out
in real use.

Both lifecycle branches also carry real code changes to `noble-transport.ts`,
`ble-session.ts`, and `ws-handler.ts` — `simplify-noble` rewrites 175 lines of
`noble-transport.ts` and adds 103 to `ble-session.ts`. Note this is *Noble-side*
lifecycle work; its value now is mainly as a record of the lifecycle model that was
being reached for, not as directly reusable code.

`origin/feature/rpc-refactor` is a third direction: redesign the WS protocol as RPC
and remove URL-param mode entirely (`BREAKING CHANGE` commit `72ea03b`). It forked
from main on 2025-08-06 and is ~2 weeks behind the other work.

## 8. Hardware and current runtime state

### The test rig

| | |
|---|---|
| Host | `knuckles` — Intel NUC5, Celeron N3050 @ 1.60GHz dual-core (Braswell) |
| RAM / disk | 8 GB / ~1 TB NVMe |
| OS | Ubuntu 24.04 Noble |
| Device under test | **CS108Reader2603A7**, MAC `6C:79:B8:26:03:A7`, service `9800` / write `9900` / notify `9901` |
| Power / uptime | Always on AC, headless, suspend targets masked system-wide |
| `sudo` | Passwordless (`sudo -n` succeeds) |

**The NUC is dedicated to this project and serves no other purpose.** That matters
for test design: disruptive recovery testing — `bluetoothd` restarts,
`hciconfig down/up`, `rfkill block`, full reboots — is safe here and disturbs
nothing else. There is no need to be gentle with the Bluetooth stack.

### ⚠️ There are TWO Bluetooth adapters, both UP

| | Device | Chipset | BT ver | BD address | State |
|---|---|---|---|---|---|
| **`hci0`** | ASUS USB dongle `0b05:1bf6` | **Realtek** | **5.4** | `BC:FC:E7:2D:76:12` | UP RUNNING |
| **`hci1`** | NUC built-in `8087:0a2a` | **Intel** | **4.2** | `34:02:86:74:B0:61` | UP RUNNING |

Verified via `/sys/class/bluetooth/hci*/device` → USB vendor/product IDs, plus
`hciconfig -a`. Note the mapping is the reverse of the intuitive guess: **the ASUS
dongle is `hci0`**, and the built-in Intel radio is `hci1`.

**This is a live finding, not just trivia.** `main.rs:343` selects the adapter with
`adapters.into_iter().nth(0).unwrap()` — **no selection logic, no filtering, no
configuration.** With two adapters present, which physical radio the bridge binds
to depends on btleplug's enumeration order, which is not guaranteed to match `hciN`
numbering or to be stable across reboots and USB re-enumeration.

The two radios are not equivalent — Realtek BT 5.4 vs Intel BT 4.2, different
firmware, different bugs. If the bridge has ever silently switched adapters between
runs, that alone could produce behavior differences that look like flakiness.
**Worth confirming which adapter the bridge actually binds to before drawing any
further conclusions about stability**, and worth making explicit (env var or
address match) rather than positional.

Related: `scripts/restart-bluetooth.js:105-107` hardcodes `hci0`. Whether that is
right depends entirely on which adapter is in use — it is a coin flip today, not a
deliberate choice. Same class of latent bug.

### Verified live, 2026-08-21

`pnpm run check:device` →
`✅ Found device: CS108Reader2603A7 [6c79b82603a7] RSSI: -67, Service UUIDs: 9800`.
Hardware is present and discoverable; Noble can still scan.

### Runtime

- **PM2 app `ble-mcp-test`: stopped.** 6 restarts on record. PM2 daemon itself is
  running (only `pm2-logrotate` online). `pm2` is not on `PATH` — use
  `./node_modules/.bin/pm2` or `pnpm exec pm2`.
- **`dist/` is stale and built from this Rust branch** (Jan 20, contains
  `rust-transport.js`). It does not correspond to `main`.
- `cargo build --release` — **succeeds** (rustc 1.89.0). Binary present at
  `rust-ble-test/target/release/rust-ble-test`.
- `tsc --noEmit` — **passes clean** on this branch.
- No BLE links currently established (`hcitool con` → empty), consistent with PM2
  being stopped.
- Untracked: `scripts/scan-all-ble.js` — a 62-line ad-hoc Noble scan/dump script.
  Not referenced by `package.json`.
- Repo root carries ~20 loose `debug-*.js` / `test-*.js` / `*.log` scratch files
  from earlier debugging sessions, all dated 2025-09-18.

## 9. Test tooling — a substantial existing asset

This repo can exercise large parts of the important functionality **directly, without
going back to trakrf**. Roughly 3,000 lines of test code across four layers:

| Layer | Files | Lines | Hardware? | Bridge? |
|---|---|---|---|---|
| `tests/unit/` | 5 | 975 | no | no |
| `tests/integration/` | 1 | 203 | yes | yes |
| `tests/e2e/` (Playwright) | 6 specs | 1,668 | yes | yes |
| Shared helpers | `connection-factory.ts`, `tests/shared/*`, `tests/e2e/test-config.ts` | ~200 | — | — |

Plus harness scripts: `check-device-available.js`, `pre-test-cleanup.js`,
`test-idle-timeout-e2e.sh`, `test-grace-period.sh`, `verify-test-exit.sh`,
`test-timeout-manager.js`, `view-metrics.js`.

Playwright is correctly configured for the single-device constraint —
`fullyParallel: false`, `workers: 1`, `headless: true`. Vitest forces
`singleFork` for the same reason.

### Measured baseline (2026-08-21, this branch)

`vitest run tests/unit` → **70 passed, 4 failed** (7.2s).

All 4 failures are in `tests/unit/testing-api.test.ts` `simulateNotification`, all
`characteristic.dispatchEvent is not a function`. **These are pre-existing and
unrelated to the Rust work** — `testing-api.test.ts` is byte-identical to `main`,
and the only spike change to `mock-bluetooth.ts` is the `writeValue`
fire-and-forget edit. The class does define `dispatchEvent` (`mock-bluetooth.ts:126`);
the test's stub characteristic doesn't. A test-harness bug, cheap to fix, but it
means the unit suite is not currently green on `main` either.

Integration and e2e were **not** run — they need a bridge and the BLE device, and
PM2 is stopped.

### The important find

**`tests/e2e/connection-lifecycle.spec.ts` (235 lines) already encodes the exact
recovery behavior that section 5 says is broken:**

- `should handle sequential reconnections with delays`
- `should handle rapid reconnections without delays`
- `should handle explicit disconnect and reconnect cycles` — drives
  `gatt.disconnect()` → wait → `gatt.connect()` on the same session
- `should maintain Noble state integrity after multiple disconnect cycles`

These were written against the Noble bridge. Against the Rust bridge they should be
expected to fail — not because the tests are wrong, but because §5.4 means the mock
never learns a disconnect happened and §5.1/§5.3 mean the bridge doesn't recover.
**That makes this spec a ready-made acceptance test for the recovery work rather
than something to write from scratch.** Its assertions may need revisiting once the
lifecycle model is decided, and the last one is named for Noble.

### Condition of the rest against the Rust bridge

Expected to be red or misleading until the protocol gap in §6 closes:

- `session-management.spec.ts` — asserts session reuse and rejection of a second
  session ID. Rust implements no session concept, so both tests are testing
  something that isn't there.
- `integration/node-client.test.ts` — `NodeBleClient` requires `sessionId`; same gap.
- `websocket-url-verification.spec.ts` — asserts the session param appears in the
  WS URL. Client-side only, so it may pass while proving nothing end-to-end.
- `uuid-format-compatibility.spec.ts` — passes only *accidentally*: it tests
  9800/9900/9901, which is exactly what Rust hardcodes. It would not catch the loss
  of device agnosticism. Worth knowing before trusting it as UUID coverage.

Likely still meaningful: `mock-bundle-validation.spec.ts` and
`notification-simulation.spec.ts` (mostly client-side).

### Stale documentation

`tests/e2e/README.md` describes six specs that **no longer exist** in this tree —
`mock-quality-assurance`, `session-rejection`, `zombie-reproduction`,
`core-session-reuse`, `disconnect-reconnect-same-session`, `real-device-session`.
(Some live on `origin/feature/rpc-refactor`.) It also documents a `pnpm dev:mock`
script that is not in `package.json`. Read the specs, not the README.

Also present: `tests/e2e/mock-bundle.spec.ts.bak` — a `.bak` file, contrary to the
"DELETE don't deprecate" rule in `CLAUDE.md`.

### Gap relative to the governing constraint

The suite tests *correctness* well. It does **not** test *stability* — there is no
soak, endurance, or long-duration test. `tests/stress/` is referenced by
`package.json`'s `test:stress` script but **the directory does not exist**. Given
that the ~99% stable connected path is the thing that must not regress, nothing in
CI would currently catch its reintroduction as a stall.

## 10. Soak harness (new — `scripts/ble-soak.js`)

Built 2026-08-21 to close the §9 gap ("the suite tests correctness but not
stability") and to settle the adapter question empirically.

```bash
node scripts/ble-soak.js --minutes 20 --label hci0-asus --mode poll
node scripts/ble-soak.js --minutes 15 --label hci0-asus-inv --mode inventory
```

Drives the bridge's WebSocket **directly** — no vite, no browser, no mock. That is
deliberate: it isolates the bridge so a failure can't be blamed on the client
stack. (The browser path exists too — trakrf's `just frontend dev-bridge` injects
the mock client — and is the right tool for validating the *client contract*, but
it's the wrong instrument for measuring radio stability.)

**Three load modes, each aimed at a different part of the path:**

- `poll` — one trigger-status command per interval, waits for each response.
  Measures latency and success rate. Light load; rate is bounded by round-trip
  latency (~25/s at 40 ms), so it is a *baseline*, not a stress test.
- `thrash` — fires alternating battery / trigger-status writes at the interval
  **without waiting for responses**. Targets the **write side**: the Rust bridge
  funnels every write through one serialized tokio task (`main.rs:483-519`) fed by
  an **unbounded** mpsc channel, so sustained write pressure is exactly where
  queue growth or write-path stalls would show up.
- `inventory` — runs the RFID bring-up sequence, then measures the **continuous
  device→host tag stream**. Targets the **notify side**: the SERVICE-SPLIT doc
  blames "CS108 inventory floods" for crashes, and stream volume is tunable by
  the number of tags in the field (8-10 for the A/B; a box of hundreds is
  available for a final push). LOCATE also streams continuously but always
  filters to a single tag, so it cannot vary load.

Write-side and notify-side stress are complementary — the serialized BLE task
handles both in one `select!`, so a stall in either starves the other.

**Metrics recorded per run** → `tmp/soak/<label>.json`: Rust panic delta (parsed
from `logs/err.log`), PM2 restart delta, BLE link drops and adapter changes (polled
via `hcitool`), WS closes/reconnects, command success rate and latency percentiles,
tag notification count and rate, stream gaps >2s, longest silence.

### CS108 inventory command reference

Recovered by cross-checking production logs against trakrf's
`tests/integration/ble-mcp-test/sequence.spec.ts` — worth recording because it was
non-trivial to reconstruct:

| Command | Bytes |
|---|---|
| RFID_POWER_ON | `A7 B3 02 C2 82 37 00 00 80 00` |
| ANT_PORT_DWELL = 0 | `… 80 02 70 01 05 07 00 00 00 00` |
| ANT_PORT_POWER = 30 dBm | `… 80 02 70 01 06 07 2C 01 00 00` |
| **START_INVENTORY** | `… 80 02 70 01 00 F0 0F 00 00 00` |
| ABORT (HST_CMD = 0) | `… 80 02 70 01 00 F0 00 00 00 00` |
| ABORT (spec A.8) | `… 80 02 40 03 00 00 00 00 00 00` |

Event codes at bytes 8-9: `0x8002` = RFID firmware command, `0x8100` = inventory
tag notification. The `TAGMSK_*` descriptor block plus `INV_CFG = 0x01E04000` are
**LOCATE-mode** settings that filter to one tag — omitted for unfiltered inventory.
Validation: the Aug-20 production log contains 35,602 `0x8100` notifications and
314 perfectly paired START/ABORT commands.

## 11. Adapter evaluation (in progress, 2026-08-21)

**Goal:** a clear signal on which radio to prefer. Deliberately scoped as an
evaluation, not a fix — design work follows separately.

### Method

Four measurements per adapter, run with the *other* adapter unbound from `btusb`
so `adapters.nth(0)` cannot pick the wrong one:

| Test | Load | What it discriminates |
|---|---|---|
| `poll` | 1 req/s, ~15 min | Baseline steady-state |
| `thrash` | alternating writes @20 ms, no waiting | Write path, serialized command queue |
| `inventory` | continuous tag stream, 8-10 tags | Notify path, stream saturation |
| **`recover`** | **10 × induced HCI disconnect** | **The actual defect (§5.0d)** |

`recover` is the important one. Per §5.0d the `bluez-async` panic fires on
**disconnect**, not under sustained load — so steady-state soaks can come back
clean on both adapters while the real defect sits untouched. The recovery test
induces a genuine link drop with `hcitool ledc <handle>` (device stays powered and
advertising, so a healthy bridge should reconnect unaided), then measures whether
recovery happens, how long it takes, and how many panics and PM2 restarts it costs.

### ⚠️ Confound to keep in mind

The first Intel observation (3 crashes in 3 minutes, §5.0b) is **not a fair
comparison** to the ASUS result. Those crashes happened while a stale link from a
failed `hciconfig hci1 down` attempt was still present — the adapter was in a
disturbed state. Intel must be re-measured from a clean baseline before any
conclusion is drawn. Any verdict below rests on the matched runs, not on that
first accident.

### Measurement caveat on `recover`

Recovery time is measured as "time until a valid device response arrives after the
HCI disconnect." Two artifacts to be aware of when reading the numbers:

- A response already in flight when the disconnect lands can be counted as
  instant recovery (an implausible 0.1 s appeared in ASUS cycle #2).
- If the link has not yet re-established when the next cycle begins, that cycle
  logs `cycle_skip: no link handle found` rather than inducing a drop — so
  "cycles run" can be lower than "cycles requested".

Neither artifact affects the **panic and restart counts**, which are the primary
signal and are read from `err.log` and PM2 rather than from timing. Both adapters
are measured with the identical method, so the comparison holds even where the
absolute recovery timings are noisy.

### Results

| Adapter | Test | Duration | Panics | PM2 restarts | Outcome |
|---|---|---|---|---|---|
| ASUS | poll @1s | 931 s | 0 | 0 | 928/929 responses, 0 timeouts, link stable |
| ASUS | *(uptime observation)* | 72 min | **0** | **0** | continuously connected |
| ASUS | recover ×10 (v1, loose) | 57 s | **0** | **0** | 7 recovered, 3 skipped (method artifact) |
| **ASUS** | **recover ×10 (rigorous)** | **94 s** | **0** | **0** | **10/10 drops confirmed, 10/10 recovered, p50 5.5 s, max 7.3 s** |
| **Intel** | **recover ×10 (rigorous)** | — | **0** | **0** | **cycle #1 did NOT recover — see below** |

### ✅ VERDICT: use the ASUS dongle (`hci0`). The result is unambiguous.

| Measurement | **ASUS** (Realtek, BT 5.4) | **Intel** (built-in, BT 4.2) |
|---|---|---|
| Induced drops confirmed | 10 | 2 |
| **Recovered** | **10 / 10** | **0 / 2** |
| Recovery time | p50 **5.5 s**, max 7.3 s | **never** (90 s timeout, ×2) |
| Functional check (same device, minutes apart) | **44/44 = 100 %**, p50 40 ms | **0/9 = 0 %**, 8 timeouts |
| Recovered after full bridge restart | n/a | **no** |
| Steady state | 72 min clean, 928/929 | clean until first disconnect |

The functional checks are the cleanest evidence: **same device, same bridge build,
same commands, minutes apart — 100 % vs 0 %.** The only variable was which radio was
bound to `btusb`. When the adapter was swapped back, ASUS re-established the link
immediately and passed 44/44, proving the device had never been the problem.

### The panic is NOT adapter-specific — do not read this verdict as "ASUS fixes it"

At **14:18:04, on the ASUS dongle**, during a bridge restart, the identical
`bluez-async` panic fired:

```
panicked at bluez-async-0.8.2/src/messagestream.rs:40:84
  called `Result::unwrap()` on an `Err` value: D-Bus error: No match with that id found
→ 🚨 Critical Rust error detected → Fatal error → Node process exited → PM2 restart
```

The bridge then came back and passed 44/44. So:

- **Panics happen on both radios**, on teardown/restart transitions, exactly as
  §5.0d predicts. ASUS is *not* panic-immune — its 10-cycle recovery run happened
  to record zero, but a restart transition produced one minutes later.
- **What the adapter changes is whether the link comes back.** ASUS re-establishes
  (10/10, ~5.5 s); Intel does not (0/2, silent zombie).

**Therefore the adapter choice and the §5.0d fix are independent and both needed.**
Switching to ASUS buys reliable recovery; it does **not** remove the panic, and the
`rust-transport.ts` stderr-scraping that escalates a survivable library panic into a
full service restart (§5.0b, lever 1) remains the highest value-to-risk fix.

**Honest caveats:**

- Intel got 2 confirmed drops to ASUS's 10 — but only because the link never came
  back, which *is* the finding. Both of its confirmed drops failed.
- Intel's panic/restart/WS-close counts (1/1/22) are contaminated by mid-run
  interventions and should not be compared directly; the drop/recovery counts are
  clean.
- An early ASUS control run was invalidated by a stale soak process still inducing
  disconnects after an adapter swap; it was re-run clean. Kill by node PID, not the
  bash wrapper.
- **The mechanism is not visible** — because Rust stdout is discarded (§5.0), we
  cannot tell whether Intel's `full_reconnect_cycle` ran and failed, or never fired
  because `is_connected()` returned a stale `true`.

### ⚠️ Operational risk: the choice is not pinned

`btusb` bind/unbind **does not survive a reboot**. On next boot both radios return,
and `adapters.into_iter().nth(0)` (`main.rs:343`) picks arbitrarily — so the box can
silently come back on the Intel radio, i.e. on the configuration that does not
recover. Until adapter selection is made explicit (env var / address match) or a
udev rule blacklists the Intel device, **verify which adapter holds the link after
any reboot** with `./scripts/select-adapter.sh status` and `hcitool con`.

### The discriminating result

The steady-state soaks did not separate the adapters — as predicted, both are fine
when nothing goes wrong. **The recovery test separated them immediately.**

**ASUS `hci0` (Realtek RTL8761B-class, BT 5.4):** 10 induced HCI disconnects, all
10 confirmed as real drops, all 10 recovered unaided. p50 **5.5 s**, max 7.3 s.
Zero panics, zero PM2 restarts, zero WebSocket closes.

**Intel `hci1` (built-in `8087:0a2a`, BT 4.2):** first induced disconnect did
**not** recover within 90 s. Observed state during the stall:

| Check | Result |
|---|---|
| BLE link (`hcitool con`) | **empty — link down** |
| Device advertising (`lescan`) | **yes — `6C:79:B8:26:03:A7 CS108Reader2603A7`** |
| Rust subprocess | **alive**, 1m47s uptime |
| WS port 8080 | **still LISTENING** |
| Panics in `err.log` | **0** |
| PM2 restarts | **0** |

**This is the zombie state the project has been fighting.** The device is healthy
and advertising. The bridge is up, has not crashed, has not panicked, and is still
happily accepting WebSocket connections — while the BLE link underneath is dead and
never re-establishes. A client sees a perfectly healthy WebSocket and receives
nothing, forever. It is a live demonstration of §5.2 (nothing detects the
disconnect) and §5.4 (clients are never told).

Note this failure is **silent — not a crash.** It would not show up in any
crash-counting metric, which is likely why it survived so long.

**And here the §5.0 correction bites directly:** because `rust-transport.ts`
discards the Rust subprocess's stdout, there is **no way to see** whether
`full_reconnect_cycle` is running and failing, or was never triggered because
`is_connected()` returned a stale `true`. The diagnostic that would answer it is
printed by `main.rs` and thrown away before reaching a log. Fixing that plumbing is
a prerequisite for diagnosing this properly.

## 12. Open questions for planning

Not answered here, listed so they aren't rediscovered later:

1. **What is the intended BLE connection lifecycle?** Process-scoped (today),
   session-scoped, or client-driven connect/disconnect? Section 5.5 is the
   architectural root of the recovery problem, and 5.1–5.4 are partly symptoms of
   never having answered this.
2. **How is a disconnect surfaced to clients?** A `disconnected`/`error` frame and a
   defined client-side reconnect contract do not exist today (5.4).
3. Does Rust own the WebSocket + session layer (per the SERVICE-SPLIT doc), or does
   Node keep `BridgeServer` with Rust replacing only `noble-transport`? The spike
   chose the former by omission rather than by decision.
4. How do the Rust bridge and Node MCP share state — Redis/Valkey as the doc
   specifies, a real IPC protocol, or something else? Log-scraping is the current
   answer and is not viable.
5. Does the RPC protocol redesign from `feature/rpc-refactor` still apply, or is it
   superseded?
6. How are device-agnostic UUIDs plumbed into Rust, given the spike hardcoded them?
7. Is there a health/liveness signal that would let either layer detect a wedged
   bridge (5.1) without a human invoking `restart_rust_bridge`?
