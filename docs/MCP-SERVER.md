# The MCP server

A read-only window onto a running bridge, for reading the raw BLE data stream and the log lines
interleaved with it while debugging an e2e failure.

**Ninety percent of the value is `read_stream`.** The other four tools are context around it.

This is not on the e2e path. Tests reach the bridge over its WebSocket; this is a separate channel
and nothing automated depends on it. CI needs none of it.

## Two processes

The bridge is long-lived and holds the device. The MCP server is a stdio process that comes and goes
with each Claude Code session, connects to the bridge's unix socket, asks one question, and gets one
answer.

They are split because a single process would cycle the hardware connection out from under whoever
holds it every time a session ended. Once they are split and co-located on one host, a unix socket
does the whole job — no port, no CORS, no bearer token.

**The MCP server never starts a bridge.** If the socket is absent it says so and exits. A debugging
tool that silently launches the thing it inspects will eventually launch a second writer alongside a
running soak, and two writers on one reader is the hazard the bridge's ownership model exists to
prevent.

## The tools

| tool | arguments | returns |
| --- | --- | --- |
| `read_stream` | `cursor`, `limit` | packets and log lines interleaved, in the order the bridge saw them |
| `search_packets` | `hex_pattern`, `limit` | packets whose hex contains the pattern |
| `get_logs` | `cursor`, `limit` | the same record with packets filtered out |
| `get_connection_state` | — | who owns the command path, its device, its observers, lifetime TX/RX counts |
| `status` | — | resolved configuration, uptime, process identity, and code currency |

`limit` defaults to 200 and must be 1–1000. Out of range is an error, not a clamp.

Every tool returns `structuredContent` against a declared `outputSchema`.

**Three tools from the TypeScript server were not ported.**

- `get_metrics` — backed by `connection-metrics.ts`, which has no Python equivalent. A tool with no
  backing is worse than an absent one; `status` and `get_connection_state` carry the operability
  need.
- `scan_devices` — scanned a local radio. There is no local radio: the bridge reaches the device
  over TCP through an ESPHome proxy. Discovery through that proxy would be a different tool with a
  different contract, and nothing has asked for one.
- `restart_rust_bridge` — died with the Rust bridge.

`get_logs` is a **tool**. It is not the MCP protocol's `logging/*` capability, which is deprecated.
A tool that returns log text and a server-to-client logging channel are different things.

## Knowing which process, and which code

Two consumers independently reached past this contract into the daemon's internals — one into
systemd's `MainPID` and unit name, one into `/proc/<pid>/cwd` plus `git log`. Both wanted answers
this surface should have given them. Co-location on one host made the workarounds possible; it never
made them correct, and a second bridge on a container is planned, where neither holds.

| field | the question it answers |
| --- | --- |
| `instance_id` | am I still talking to the same process? |
| `code_fingerprint` | is that process running the code in this tree? |
| `code_source_root` | which tree is the right one to compare against? |

### `instance_id`

A uuid minted at process start. Stable for the life of the process, different after every restart,
so comparing it is an equality check. That is the whole gain: the arithmetic it replaces needed a
tolerance window, and every second of slack in such a window is a second a real restart can hide in.

**It does not replace `uptime_seconds`, and a consumer that drops the elapsed-time check loses a
signal.** The two answer different questions:

    instance_id     -- is this a DIFFERENT PROCESS
    uptime_seconds  -- has this process been running for the WHOLE INTERVAL I measured

A restart moves both. A **host suspend** moves only the second: `uptime_seconds` derives from
`time.monotonic()`, which reads `clock_gettime(CLOCK_MONOTONIC)` on this platform, and
CLOCK_MONOTONIC is documented not to advance while the host is suspended — CLOCK_BOOTTIME is the one
that includes suspended time. So an hour of suspend leaves `instance_id` unchanged while an hour of
wall clock passes that the run did not experience.

That last paragraph mixes two grades of claim and the difference matters: the clock implementation
and `adjustable=False` are readings taken from the running interpreter via
`time.get_clock_info('monotonic')`; CLOCK_MONOTONIC's suspend behaviour is taken from its
documentation, not measured here. A run that judges evidence continuity rather than process identity
needs both fields. There is also a weaker asymmetry worth keeping: the daemon *chooses*
`instance_id`, while it does not control the clock behind `uptime_seconds` — two records, one of
which the subject cannot author.

### `code_fingerprint` and `code_source_root`

A sha256 over the `.py` files of the bridge package, hashed **once, at process start, and never
recomputed**. That timing is the load-bearing part. Every other field here is read per call, so
per-call is a reader's default assumption — and under it this field would be useless, because a
post-start edit would fold silently into the answer and the daemon would always look current. Read
once, it names the code the process came up on.

To use it, fingerprint the tree named by `code_source_root` and compare. A difference means the
daemon predates that code and would have answered your run without saying so.

**Fingerprint the tree the field names, not your own.** Judging a daemon against the current tree
reports a perfectly current daemon as stale whenever a worktree holds commits touching `bridge/` —
the wrong denominator, presenting as a stale daemon. Publishing the root is what lets a consumer stop
reading `/proc/<pid>/cwd` to find it.

The algorithm is written out in full in `bridge/src/ble_bridge/identity.py`, because a consumer
re-deriving it in another language has to agree exactly: two implementations that differ produce a
permanent false STALE, and the natural response to persistent noise is to loosen the check, which is
how a guard stops working. From Python, import it rather than reimplementing:

```python
from ble_bridge.identity import source_fingerprint
```

Two things it deliberately is not. It is **not a git commit sha**: a sha does not move for an
uncommitted edit, so it would report a clean identity for dirty code — a silent fallback wearing
configuration's clothes — and it would need `git` and a checkout at runtime, which an image does not
have. It is **not a hash of the modules loaded so far**: Python imports lazily, so at start most of
the package is not in `sys.modules`, and that hash would describe the bootstrap rather than the
daemon.

One bounded gap, stated rather than designed away: a file edited *during* startup, between an
earlier module's import and the fingerprint, is hashed in its new form while the process runs the
old. It fails toward reporting a mismatch — toward telling someone to restart — never toward
reporting clean for dirty.

### `version` is not a currency signal

It carries the released version of the package, taken from `package.json`; the mock and the bridge
ship as one release, and one generated file feeds both. It is the right field for *which release is
this* and the wrong one for *is this daemon current*, and that is a property of what a release number
means rather than of what it happens to read: **a release number moves on release and code moves on
merge, so two daemons at the same released version can be serving different code.** That gap is the
2026-08-28 incident, where a daemon had to be killed before publishing because it was serving
pre-merge code. `code_fingerprint` is the field that sees it.

### Post-mortem is out of scope, by design

`get_logs` is a per-process ring, so a restart empties it: it cannot explain the restart it just
survived. That is not a gap to close here. A crashed process cannot report its own death; observing
it takes an out-of-process observer, which is what a supervisor is. Use `journalctl --user -u
ble-bridge` — a person doing forensics after the fact is not code coupled to a log format or a unit
name, which is the coupling these fields exist to remove.

## Reading the stream

Call `read_stream` with no cursor to see what the ring holds. Keep `next_cursor` from the reply and
pass it back as `cursor` on the next call to get only what is new. `next_cursor` holds its place
when nothing arrived, so polling a quiet stream does not rewind.

Two fields say when the answer is not what it looks like:

- **`dropped_before`** — the ring evicted entries the cursor had not reached. Its value is the
  oldest id still held; everything between the cursor and it existed and is gone. An evicted entry
  is absent rather than renumbered, which is honest and completely invisible without this field.
- **`buffer_enabled: false`** — the bridge is recording nothing because `BLE_MCP_LOG_BUFFER_SIZE=0`.
  `notice` says so in a sentence. An empty result in that state says nothing about the device.

Packets are stored as uppercase space-separated hex (`A7 B3 02`). `search_packets` matches a
substring of that, ignoring spacing and case, so `a7b3` and `A7 B3` find the same frames. A pattern
that is not hexadecimal is an error rather than an empty result — `zz` can never match, and zero
results would read as "the device never sent that".

## The socket contract

Newline-delimited JSON over `AF_UNIX`. One request per line, one reply per line, in order, on a
connection the client closes. No server-initiated messages, no streaming.

```
request   {"op": <name>, "args": {...}}      -- "args" may be omitted
reply     {"ok": true,  "result": {...}}
          {"ok": false, "reason": "<a sentence>"}
```

The op names are the tool names. Lines over 64 KiB are refused rather than buffered.

**Path:** `$BLE_MCP_SOCKET_PATH` if set, else `$XDG_RUNTIME_DIR/ble-bridge.sock`, else
`/tmp/ble-bridge-$UID.sock`. Must be absolute — the two processes have separate working
directories. The bridge logs the resolved path at startup.

**Mode 0600, owner only.** That is the entire authorization story, and it is why no token replaced
`BLE_MCP_HTTP_TOKEN`.

**Direction:** the MCP process is always the client. The bridge never calls out and does not know
whether an MCP process exists.

Three refusals are deliberate. An unknown op names the ops that exist, so a caller reaching for
`get_metrics` learns it was dropped rather than that the socket is broken. An unknown argument is
refused rather than ignored, because a silently dropped filter returns the wrong rows and they look
exactly like data. An out-of-range `limit` is refused rather than clamped, because a clamp leaves
the caller's own value in the request, apparently in force.

Starting the bridge over a socket file that something is still listening on is refused too. A file
left behind with nothing listening is a stale socket from a hard kill, and is removed with a warning.

## Registering it

```bash
claude mcp add ble-mcp-test -- uv run --script /path/to/ble-mcp-test/mcp-server/ble_mcp.py
```

or, in `~/.claude.json` under `projects.<path>.mcpServers`:

```json
"ble-mcp-test": {
  "type": "stdio",
  "command": "uv",
  "args": ["run", "--script", "/path/to/ble-mcp-test/mcp-server/ble_mcp.py"],
  "env": {}
}
```

`mcp-server/ble_mcp.py` is a PEP 723 single-file script: its dependency block pins the official MCP
Python SDK (`mcp==2.1.0`, class `mcp.server.MCPServer`), and `uv` resolves it on first run. There is
nothing to install and nothing to build.

A Claude Code session reads `~/.claude.json` at startup, so a change here needs a restart.

## When it says the bridge is down

It means nothing is listening on the socket. Start one:

```bash
cd bridge && uv run python -m ble_bridge
```

Without `ESPHOME_PROXY_HOST` and `BLE_MCP_DEVICE_MAC` it runs the stub transport and reaches no
device — fine for protocol work, useless for reading real frames.

To answer "is the bridge up and carrying traffic" without a Claude session:

```bash
uv run --script mcp-server/ble_mcp.py --check
```

It prints a one-line summary and exits 0, or prints why and exits 2. It connects and reads; it
starts nothing.
