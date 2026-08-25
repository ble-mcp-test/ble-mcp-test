# Python package layout

**Status:** BUILT. Companion to `2026-08-23-python-bridge-rewrite.md`.

The socket half of this shipped in TRA-1161 and the sections below are corrected to what is in the
tree, not what was proposed. Three things changed in the building, each marked **[changed in
TRA-1161]** where it appears:

1. the shim is at `mcp-server/ble_mcp.py`, not `mcp/ble_mcp.py`;
2. the ring buffer is `log_buffer.py`, not `observability.py`, and there is no metrics module;
3. six requests became five, and two of the six were dropped rather than ported.

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
    log_buffer.py                   # the ring: packets and log lines interleaved

mcp-server/
  ble_mcp.py                        # PEP 723 single-file script, `uv run --script`
```

**[changed in TRA-1161] `mcp-server/`, not `mcp/`.** A top-level `mcp/` directory shadows the `mcp`
SDK distribution — which is what the shim imports — for anything running with the repo root on
`sys.path`. The failure would be an import error a long way from its cause.

**[changed in TRA-1161] `log_buffer.py`, not `observability.py`.** Connection state is read straight
off `ws/ownership.py`'s `CommandPath`, so there is nothing for a separate module to own, and there
is no metrics tracker at all — see the request table below.

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

**Path:** `$BLE_MCP_SOCKET_PATH` if set, else `$XDG_RUNTIME_DIR/ble-bridge.sock`, falling back to
`/tmp/ble-bridge-$UID.sock`. Must be absolute. `0600`, owner-only — that is the whole authorization
story, and it is why no bearer token is needed.

Two processes resolve that rule from two files that cannot import each other, so it is checked
mechanically by `bridge/tests/test_mcp_shim.py::test_both_processes_resolve_the_same_socket_path`
rather than by eye. Copied by eye it would fail as a timeout, and the symptom would be "the bridge is
down" — which is also the shim's honest message for a bridge that really is down.

**Framing:** newline-delimited JSON. One request, one response. No streaming, no server-initiated
messages. `{"ok": true, "result": {...}}` or `{"ok": false, "reason": "<sentence>"}` — `reason`
rather than `error` because `error` is a WebSocket message type, and `protocol.py` owns that name.

**Direction:** the MCP process is always the client; the bridge never calls out. This matters — it
means the bridge has no knowledge of whether an MCP process exists, and starting or killing one has
no effect on the BLE connection.

**Requests** map one-to-one to the MCP tools. **[changed in TRA-1161]** six became five, and the one
this design did not name is the one that matters most:

| Request | Returns |
|---|---|
| `read_stream` | the ring, packets and log lines interleaved, after a cursor |
| `search_packets` | matching packets |
| `get_logs` | the same ring with packets filtered out |
| `get_connection_state` | command-path ownership, device, observers, lifetime TX/RX |
| `status` | daemon status |

`read_stream` is the ninety percent. The original table listed `get_logs` first and had no cursored
raw-stream read at all, which understated what platform actually uses this for.

Three tools were **not** ported:

- `restart_rust_bridge` — dies with the Rust bridge.
- `get_metrics` — `connection-metrics.ts` has no Python equivalent and TRA-1163 deletes it. A tool
  with no backing is worse than an absent one; `status` and `get_connection_state` carry the need.
- `scan_devices` — scanned a local radio, and there is no local radio. Discovery through the ESPHome
  proxy would be a different tool with a different contract, and nothing has asked for one.

**Failure mode:** if the socket is absent or refuses, the MCP process reports the bridge as down. It
must **not** start one — a debugging tool that silently launches the thing it is inspecting will
eventually launch a second one alongside a running soak, which is exactly the multi-writer hazard the
ownership model exists to prevent.

---

## uv boundaries

**MCP process — PEP 723 single-file.** `mcp-server/ble_mcp.py` with an inline dependency block,
pinning the official MCP Python SDK (`mcp==2.1.0`, class `mcp.server.MCPServer`); run via
`uv run --script mcp-server/ble_mcp.py`. It is a thin stdio shim over the socket with no state, so a
single file is honest about its size and needs no packaging.

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

1. **Where does the firehose harness live?** Settled by building: `bridge/tests/stress/`. It drives
   the bridge, and that is where it can. One caveat learned the hard way — it asserts
   `saturated_ticks == 0`, so it is sensitive to whatever else the test process is doing, including
   work done at collection time by unrelated test files.
2. **Does `bridge/` live in this repo or its own?** Settled by building: this repo, with `just` as
   the cross-language front door and `uv` owning everything under `bridge/`.
3. **Ring-buffer ownership.** `log_buffer.py` holds it in the daemon, which is right for lifetime —
   but it means MCP queries cross the socket for every read. Still fine at human speed; the cursor
   makes a poll cheap, and nothing polls it today.
