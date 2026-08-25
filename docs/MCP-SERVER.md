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
| `status` | — | resolved configuration and uptime |

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
