# Replatform — ticket decomposition (DRAFT, not yet filed)

**Status:** DRAFT for review. Nothing filed in Linear yet. Filing is cheap; unfiling is
embarrassing, and a bad decomposition propagates into whoever picks the work up.

Derived from `2026-08-23-python-bridge-rewrite.md`, `2026-08-23-ws-protocol-spec.md`, and
`2026-08-23-bleak-esphome-notify-audit.md`. All under team **TrakRF**, all related to **TRA-1155**.

---

## Dependency graph

```
  T0 (MCP floor fix) ────── independent, do now
  T1 (node/ decision) ───── independent, unblocks T5 scope

  T2 (firehose harness) ─┬─> T3 (bridge core: connected/data)
                         │      └─> T4 (error/warning + single-writer)
                         │             └─> T6 (cleanup family)
                         └─> validates the notify audit's one unmeasured claim

  T5 (MCP on FastMCP) ─── last; depends on T3 only for the unix socket
```

---

## T0 — Fix the `@modelcontextprotocol/sdk` version floor

**Independent of the rewrite. Do this now.**

- **Scope:** `package.json` declares `"@modelcontextprotocol/sdk": "^1.0.4"`; the lockfile resolves
  `1.17.0`, and `StreamableHTTPServerTransport` (imported at `src/mcp-http-transport.ts:4`) did not
  exist at `1.0.4`. The manifest lies about what the code needs.
- **Acceptance:** declared floor is a version that actually contains every imported symbol; a clean
  install honouring the floor builds and starts.
- **Blocks:** nothing. **Blocked by:** nothing.
- **Size:** one line plus verification.

## T1 — Decide the fate of `src/node/`

- **Scope:** 843 lines, 7 files, 28 tests (`tests/unit/node-client.test.ts` 17,
  `tests/integration/node-client.test.ts` 11), **no known consumer.** It is a client library, so it
  stays TypeScript under this ADR — but "stays" was a default, not a decision.
- **Deliverable:** an explicit decision — keep, or delete with its tests. **Not** a silent port and
  **not** a silent deletion.
- **Acceptance:** decision recorded with a rationale; if kept, a named consumer or a stated reason to
  retain it without one.
- **Blocks:** T5 scope (whether the Node client's `error`/`ack` handling matters).
- **Note:** `ack` is consumed at `NodeBleClient.ts:314` and sent by nobody — if `src/node/` goes, that
  dead branch goes with it.

## T2 — Firehose stress harness *(do first)*

- **Scope:** injected-notification load generator, field-free, no hardware. Drives the bridge at
  10-100× the ~45 msg/s production rate.
- **Why first:** validates the language choice at rate *before* the rewrite, and leaves a regression
  net for everything after. **Second purpose:** it is the only thing that settles the one unmeasured
  claim in the notify audit — that per-notification cost survives 10-100×. That claim is currently
  marked `[inferred]`, explicitly not clearance.
- **Acceptance:** sustained run at a stated multiple of 45 msg/s with no message loss, no unbounded
  memory growth, and recorded p50/p99 per-notification latency. Runs against the *current* stack so
  it produces a baseline to compare the Python bridge against.
- **Blocks:** T3. **Blocked by:** nothing.

## T3 — Python bridge core: `connected` + `data`

- **Scope:** `aioesphomeapi` / `bleak-esphome` connection, WS server, and the two message types that
  carry all real traffic. To the spec in `2026-08-23-ws-protocol-spec.md`, including the nine URL
  query parameters.
- **Acceptance:**
  - the soak harness runs against the Python bridge with results comparable to the Rust bridge;
  - **non-trivial per-notification work happens behind the bridge's own queue** — the notify callback
    runs synchronously on the event loop and must not block it;
  - **notify-path errors are surfaced deliberately from inside the callback** (`aioesphomeapi` routes
    handler exceptions to its own logger; nothing propagates them for us);
  - every task is awaited or given an explicit done-callback;
  - `_mv` handled as telemetry only, matching current behaviour.
- **Blocks:** T4, T5. **Blocked by:** T2.

## T4 — `error` + `warning`, and single-writer / multi-observer ownership

- **Scope:** the two remaining live server→client messages, plus the concurrency model.
- **Ownership model:** one client owns the command path; a second claim is **rejected loudly with a
  distinguishable error** — not queued, not shared. Additional clients attach **read-only** to the
  notification stream.
- **Acceptance:**
  - **ownership is per-CONNECTION, not per-session.** Restoring the TypeScript behaviour verbatim
    reproduces a guard that never covered the common case — both repos pin a fixed per-host session
    id, so shared-writer is the configured norm;
  - a second writer receives a distinguishable error, not a timeout and not silence;
  - an observer can read the stream and cannot write;
  - `warning` is interstitial — the client keeps waiting — and does not terminate a handshake;
  - **every request/response pair has its wait condition checked against its emitter mechanically**
    (a test or a shared constant), never by eye.
- **Blocks:** T6. **Blocked by:** T3.

## T5 — MCP on FastMCP, split over a unix socket

- **Scope:** 6 tools ported (`get_logs`, `search_packets`, `get_connection_state`, `status`,
  `get_metrics`, `scan_devices`) and 1 deleted (`restart_rust_bridge`, which dies with the Rust
  bridge). PEP 723 single-file script for the stdio MCP process; the bridge stays long-running.
- **Why split:** in dev, Claude Code sessions come and go while the bridge must not — one stdio
  process would cycle the hardware connection out from under whoever holds it. CI needs no MCP.
- **Deletes:** Express, CORS, `BLE_MCP_HTTP_TOKEN`, MCP session management, the port, and the
  `stdioEnabled = hasTty && !stdioDisabled` gotcha at `mcp-http-transport.ts:225-227`.
- **Acceptance:** tools reachable over stdio; unix socket contract documented; no HTTP surface
  remains; `structuredContent`/`outputSchema` on at least `get_logs` and `get_connection_state`,
  which currently return prose.
- **Blocked by:** T3 (needs the socket). **Note:** confirm the 2026-07-28 MCP re-architecture
  independently first — those claims are second-hand and unverified here. If they hold, the MCP
  surface needs a protocol rewrite in *either* language, which is why this sequences last.

## T6 — Cleanup family: root-cause, then decide

- **Scope:** there is currently **no working graceful cleanup.** `cleanup_session` has no sender; its
  completion handler waits on `cleanup_complete`, which nothing sends (the server sends
  `session_cleanup_complete`); and the one live path, `force_cleanup`, is annotated by its own author
  as *"broken - creates zombies"* (`ws-transport.ts:195`).
- **Deliverable:** root cause for the `force_cleanup` zombie, **then** a decision — reimplement, fix,
  or drop. Do not port the behaviour without understanding it.
- **Acceptance:** zombie mechanism explained; a cleanup path that works end to end, or a recorded
  decision that none is needed.
- **Blocked by:** T4.
- **Drop as part of this:** `cleanup_session`/`session_cleanup_complete` and
  `admin_cleanup`/`admin_cleanup_complete` — dead on both ends, safe to remove as units. Also the
  phantom union members (`eviction_warning`, `keepalive_ack`, `scan_result`, `notification`).

---

## Deliberately not tickets

- **Identifier masking and the `HARDWARE_REMINDER.md` self-contradiction** — belongs to TRA-1155,
  already recorded there.
- **The CORS / `0.0.0.0` exposure** — live today (`origin: '*'` at `mcp-http-transport.ts:23` plus a
  wide bind, with `BLE_MCP_HTTP_TOKEN` consulted only if set). Largely *deleted* by T5 rather than
  fixed, but T5 is months out. **Flagged for Mike as a standalone decision:** fix now, or accept the
  exposure until T5.
- **A dedicated always-on reader rig** — a hardware-spend question for Mike, and its value accrues
  mainly to platform's application-level e2e, not to this repo.

## Open

- Should T2's harness live in this repo or platform's? It drives the bridge, so this repo — but it
  exercises the mock, which platform consumes. **[inferred]** here.
- T6 may reveal the zombie is a Noble-specific artifact that does not exist in Python at all, which
  would collapse it to a deletion.
