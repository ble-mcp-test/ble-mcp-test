# Python package layout

**Status:** DRAFT / lowest-priority item of the replatform design package. Companion to
`2026-08-23-python-bridge-rewrite.md`.

Two processes with different lifetimes, joined by a unix socket. That split is the whole shape of
the design; everything else follows from it.

---

## Why two processes

**The bridge must outlive the MCP client.** In development, Claude Code sessions come and go while
the BLE connection must not — a single stdio process would cycle the hardware connection out from
under whoever holds it. **CI needs no MCP at all**, so in CI the second process simply never starts.

This is also what deletes the HTTP surface. The MCP server needed to be network-reachable only
because it had to sit adjacent to hardware; co-located, a unix socket does the job with no Express,
no CORS, no `BLE_MCP_HTTP_TOKEN`, no port, and no `stdioEnabled = hasTty && !stdioDisabled` gotcha.

---

## Layout

```
bridge/                             # pyproject + uvx, long-running daemon
  pyproject.toml
  src/ble_bridge/
    __init__.py
    __main__.py                     # uvx entrypoint; arg parsing, signal handling
    config.py                       # env only — see "Configuration" below
    esphome.py                      # aioesphomeapi / bleak-esphome ownership
    notify.py                       # the synchronous-callback boundary (see below)
    ws/
      server.py                     # websockets server, connection accept
      protocol.py                   # message constants + encode/decode
      ownership.py                  # single-writer / multi-observer
    control.py                      # unix socket server for the MCP process
    observability.py                # ring buffer, metrics, connection state

mcp/
  ble_mcp.py                        # PEP 723 single-file script, uvx-runnable
```

**`protocol.py` is load-bearing.** Hazard 1a's design rule — wait conditions checked against
emitters mechanically, never by eye — is satisfied by having exactly one module define every message
name and shape, with both the WS server and the tests importing from it. No string literal for a
message type should appear anywhere else in the tree.

**`notify.py` exists as its own module** because it is where the audit's constraint lands: the
`aioesphomeapi` callback runs synchronously on the event loop, and `aioesphomeapi` swallows any
exception it raises into its own logger. So that boundary owns two obligations — hand off to a queue
immediately, and surface errors deliberately rather than relying on them propagating. Both are
invisible if the code is scattered; a named module makes the boundary reviewable.

---

## The unix socket contract

**Path:** `$XDG_RUNTIME_DIR/ble-bridge.sock`, falling back to `/tmp/ble-bridge-$UID.sock`.
`0600`, owner-only — that is the whole authorization story, and it is why no bearer token is needed.

**Framing:** newline-delimited JSON. One request, one response. No streaming, no server-initiated
messages.

**Direction:** the MCP process is always the client; the bridge never calls out. This matters — it
means the bridge has no knowledge of whether an MCP process exists, and starting or killing one has
no effect on the BLE connection.

**Requests** map to the six surviving MCP tools:

| Request | Returns |
|---|---|
| `get_logs` | ring-buffer contents, filtered |
| `search_packets` | matching packets |
| `get_connection_state` | current BLE + WS state |
| `status` | daemon status |
| `get_metrics` | connection metrics |
| `scan_devices` | discovered devices |

`restart_rust_bridge` is **not** ported — it dies with the Rust bridge.

**Failure mode:** if the socket is absent or refuses, the MCP process reports the bridge as down. It
must **not** start one — a debugging tool that silently launches the thing it is inspecting will
eventually launch a second one alongside a running soak, which is exactly the multi-writer hazard the
ownership model exists to prevent.

---

## uv boundaries

**MCP process — PEP 723 single-file.** `mcp/ble_mcp.py` with an inline dependency block; run via
`uvx ble_mcp.py`. It is a thin stdio shim over the socket with no state, so a single file is honest
about its size and needs no packaging.

**Bridge — `pyproject.toml` + `uvx`.** A real package: multiple modules, third-party dependencies
(`aioesphomeapi`, `bleak-esphome`, `websockets`), and a console entrypoint. Run as
`uvx --from ./bridge ble-bridge` in dev, or from a published artifact later if that is ever wanted.

**No systemd, no pm2, no supervision shipped.** The bridge is a **test fixture**, started and
stopped by whatever runs the tests. platform's `playwright.config.ts` already has a `webServer` hook
for exactly this shape. Supervision is the user's business.

---

## Configuration

**Environment variables only, read at startup, no file parsing.** This is deliberate and it is a
direct response to a defect being retired: the Rust bridge's `Config::from_env()` silently ignored a
`.env.local` that contained precisely the two variables selecting the ESPHome backend — config that
was present, correct-looking, and dropped on the floor.

So: either the process reads `.env` files properly (a real dependency, real precedence rules), or it
reads only the environment and **the documentation says so plainly**. What it must never do is
appear to support a file it ignores. Given the bridge is launched by a test harness that can
`set -a; source .env.local; set +a`, environment-only is the smaller and more honest surface.

Names carry over unchanged from the current `BLE_MCP_*` convention plus `ESPHOME_PROXY_HOST`.

---

## Open

1. **Where does the firehose harness live?** It drives the bridge (suggesting here) but exercises
   the mock (which platform consumes). Unresolved; **[inferred]** here.
2. **Does `bridge/` live in this repo or its own?** This repo, presumably, since the mock and the
   Node client stay TypeScript alongside it — but a Python package inside a pnpm workspace wants a
   deliberate decision about tooling boundaries rather than a default.
3. **Ring-buffer ownership.** `observability.py` holds it in the daemon, which is right for
   lifetime — but it means MCP queries cross the socket for every log read. Fine at human speed;
   worth revisiting only if something starts polling.
