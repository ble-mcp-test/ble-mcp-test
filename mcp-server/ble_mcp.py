#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["mcp==2.1.0"]
# ///
"""ble-mcp-test's MCP server: a read-only window onto a running bridge.

## What it is for

`trakrf/platform` uses this to read the bridge's raw BLE data stream and its logs
while debugging an e2e failure. Ninety percent of the value is the raw stream:
`read_stream` is the tool that matters, and the other four are context around it.

This is not on the e2e path. Tests reach the bridge over its WebSocket; this is a
separate channel, and nothing automated depends on it. Losing it costs visibility,
not coverage. CI needs none of it.

## Shape

A thin stdio shim. It holds no state of its own: every tool is one request over the
bridge's unix socket and one reply back, and the cursor a caller carries between
calls is the only thing resembling a session. That is deliberate -- the 2026-07-28
MCP revision retired transport-level sessions in favour of exactly this, handles
minted by tools and passed back as arguments.

It is a single file, run straight out of the checkout, because that is honest about
its size. Do not grow it into a package: everything with state lives in the bridge.

Built on the **official MCP Python SDK, `mcp==2.1.0`** -- class `mcp.server.MCPServer`,
which is what the in-SDK FastMCP was renamed to in v2. Not the standalone `fastmcp`
distribution, whose stateful-application machinery none of this needs.

`get_logs` is a **tool**. It is not the protocol's `logging/*` capability, which is
deprecated; a tool that returns log text and a server-to-client logging channel are
different things, and only the second one is going away.

## What it will never do

**Start a bridge.** If the socket is absent or refuses, this reports the bridge as
down and stops. A debugging tool that silently launches the thing it inspects will
eventually launch a second writer alongside a running soak, and two writers on one
reader is the hazard the bridge's whole ownership model exists to prevent.

## Where it lives

`mcp-server/ble_mcp.py`, not `mcp/ble_mcp.py` as
docs/design/2026-08-23-python-package-layout.md proposed: a top-level `mcp/`
directory shadows the `mcp` SDK package for anything running with the repo root on
sys.path, and the failure would be an import error a long way from its cause.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import Mapping
from typing import Any

from mcp.server import MCPServer
from pydantic import BaseModel, Field

VERSION = "1.0.0"

SOCKET_PATH_ENV = "BLE_MCP_SOCKET_PATH"
SOCKET_BASENAME = "ble-bridge.sock"

#: Connecting to a socket on the same host is instant or it is never going to work.
CONNECT_TIMEOUT_S = 5.0
#: One reply to one request against an in-memory ring. Generous, and bounded: a
#: wait with no ceiling would present a wedged bridge as a hung Claude session.
REPLY_TIMEOUT_S = 30.0
MAX_LINE_BYTES = 64 * 1024

_DISABLED_HINT = (
    "If `buffer_enabled` is false the bridge is recording nothing "
    "(BLE_MCP_LOG_BUFFER_SIZE=0) and an empty result says nothing about the device."
)


class BridgeDown(RuntimeError):
    """No bridge is listening on the socket."""


class BridgeRefused(RuntimeError):
    """The bridge answered, and the answer was no. Its sentence, verbatim."""


def resolve_socket_path(env: Mapping[str, str] | None = None) -> str:
    """Where the bridge listens.

    `$BLE_MCP_SOCKET_PATH` if set, else `$XDG_RUNTIME_DIR/ble-bridge.sock`, else
    `/tmp/ble-bridge-$UID.sock`.

    This duplicates `ble_bridge.config.default_socket_path` and cannot import it:
    this file is a single script by design. A rule copied by eye is the wait
    condition that fails as a timeout, and here it would fail as "the bridge is
    down" -- which is also this shim's honest message for a bridge that really is
    down, so the two would be indistinguishable.
    `bridge/tests/test_mcp_shim.py::test_both_processes_resolve_the_same_socket_path`
    checks the two implementations against each other over a matrix of
    environments. Change either one and it goes red.
    """
    env = os.environ if env is None else env
    override = env.get(SOCKET_PATH_ENV)
    if override is not None and override.strip():
        path = override.strip()
        if not os.path.isabs(path):
            raise ValueError(
                f"{SOCKET_PATH_ENV} is {path!r}, which is not an absolute path. The "
                "bridge and this process have separate working directories, so a "
                "relative path names two different files."
            )
        return path
    runtime_dir = env.get("XDG_RUNTIME_DIR")
    if runtime_dir is not None and runtime_dir.strip():
        return os.path.join(runtime_dir.strip(), SOCKET_BASENAME)
    return f"/tmp/ble-bridge-{os.getuid()}.sock"


async def ask(op: str, **args: Any) -> dict[str, Any]:
    """One request, one reply. A fresh connection per call, deliberately.

    Holding one open would be a session, and this process is the come-and-go half
    of the split: a connection kept across a whole Claude Code session would
    outlive the questions it was opened for and tell nobody when it died.
    """
    path = resolve_socket_path()
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(path, limit=MAX_LINE_BYTES), CONNECT_TIMEOUT_S
        )
    except (FileNotFoundError, ConnectionRefusedError, PermissionError, OSError, TimeoutError) as e:
        raise BridgeDown(_down_message(path, e)) from e

    try:
        writer.write((json.dumps({"op": op, "args": args}) + "\n").encode())
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), REPLY_TIMEOUT_S)
    except TimeoutError as e:
        raise BridgeDown(
            f"the bridge at {path} accepted the connection but did not answer "
            f"{op!r} within {REPLY_TIMEOUT_S:g}s. It is running but not responding."
        ) from e
    except (ConnectionResetError, BrokenPipeError) as e:
        raise BridgeDown(f"the bridge at {path} closed the connection mid-request: {e}") from e
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except (ConnectionResetError, BrokenPipeError):
            pass

    if not line:
        raise BridgeDown(
            f"the bridge at {path} closed the connection without answering {op!r}."
        )
    reply = json.loads(line)
    if not reply.get("ok"):
        raise BridgeRefused(
            reply.get("reason", "the bridge refused the request without saying why")
        )
    return reply["result"]


def _down_message(path: str, exc: Exception) -> str:
    return (
        f"no bridge is listening on {path} ({type(exc).__name__}: {exc}). "
        "This MCP server will NOT start one -- it is a read-only window onto a "
        "bridge somebody else is running, and starting a second one alongside a "
        "live session would put two writers on one radio. Start it yourself with "
        "`cd bridge && uv run python -m ble_bridge`, or point "
        f"{SOCKET_PATH_ENV} at the bridge that is already running."
    )


# --- what the tools return ----------------------------------------------------
#
# Declared rather than passed through as dicts, so the SDK derives an outputSchema
# and every reply comes back as structuredContent. It also means a drift in the
# socket contract fails validation here instead of silently dropping a field.


class Entry(BaseModel):
    """One packet or one log line, in the order the bridge saw it."""

    id: int = Field(description="Monotonic id. Pass the last one back as `cursor`.")
    timestamp: str
    direction: str = Field(description="TX or RX for a packet; a log level for a log line.")
    text: str = Field(description="Uppercase spaced hex for a packet, the message for a log line.")
    size: int = Field(description="Payload bytes. 0 for a log line.")
    is_packet: bool


class StreamResult(BaseModel):
    entries: list[Entry]
    next_cursor: int | None = Field(
        description="Pass as `cursor` next call. Holds its place when nothing new arrived."
    )
    dropped_before: int | None = Field(
        description=(
            "Set when the ring evicted entries the cursor had not reached yet; its value "
            "is the oldest id still held. Entries between the cursor and it are gone."
        )
    )
    buffer_enabled: bool
    buffer_size: int
    notice: str | None


class SearchResult(BaseModel):
    entries: list[Entry]
    count: int
    pattern: str
    buffer_enabled: bool
    buffer_size: int
    notice: str | None


class ConnectionState(BaseModel):
    held: bool = Field(description="Whether any connection owns the command path.")
    session: str | None
    ready: bool = Field(description="Whether the owner's device link is up.")
    device_name: str | None
    device_id: str | None
    observer_count: int = Field(description="Read-only connections attached to the owner.")
    packets_transmitted: int = Field(description="Lifetime total for the bridge process.")
    packets_received: int = Field(description="Lifetime total for the bridge process.")


class Status(BaseModel):
    version: str
    uptime_seconds: float
    ws_host: str
    ws_port: int
    ws_loopback: bool
    log_level: str
    log_timestamps: bool
    log_buffer_size: int
    log_buffer_enabled: bool
    idle_timeout: float
    socket_path: str
    esphome_configured: bool
    esphome_proxy: str | None
    device_mac: str | None


# --- the tools ----------------------------------------------------------------


async def read_stream(cursor: int | None = None, limit: int = 200) -> StreamResult:
    """Read the bridge's raw BLE traffic and log lines as one ordered stream.

    This is the main tool. Packets and log lines are interleaved in the order the
    bridge saw them, because the question a post-mortem asks is "what was on the
    wire around the moment it went quiet", which separate logs cannot answer.

    Call it with no cursor to see what is in the ring, then pass `next_cursor` back
    on each subsequent call to read only what is new. `dropped_before` tells you the
    ring evicted entries you had not read yet.
    """
    return StreamResult(**await ask("read_stream", cursor=cursor, limit=limit))


async def search_packets(hex_pattern: str, limit: int = 200) -> SearchResult:
    """Find packets whose hex contains a pattern, e.g. "A7B3" or "a7 b3".

    Spacing and case in the pattern are irrelevant. A pattern that is not
    hexadecimal is an error rather than an empty result: "zz" can never match, and
    zero results would read as "the device never sent that".

    Only packets are searched; a log line that happens to contain the same
    characters is prose, not a frame.
    """
    return SearchResult(**await ask("search_packets", hex_pattern=hex_pattern, limit=limit))


async def get_logs(cursor: int | None = None, limit: int = 200) -> StreamResult:
    """Read the bridge's log lines, with the BLE packets filtered out.

    Same cursor as `read_stream` -- the two read one shared record -- so a cursor
    from either tool is valid in the other. Use `read_stream` instead when the
    question is what happened around a particular moment.
    """
    return StreamResult(**await ask("get_logs", cursor=cursor, limit=limit))


async def get_connection_state() -> ConnectionState:
    """Who owns the bridge's command path right now, and how much has flowed.

    One connection owns the command path and writes to the device; any number of
    others attach read-only. `observer_count` above zero with an unexpected session
    id is usually a stray browser tab.

    The packet counters are lifetime totals for the bridge process and keep
    counting even when the log buffer is switched off.
    """
    return ConnectionState(**await ask("get_connection_state"))


async def status() -> Status:
    """The bridge's resolved configuration and how long it has been up.

    Useful mostly for confirming that the bridge you are reading is the one you
    think you are reading: the WebSocket bind, the log level actually in force, the
    ring size, and whether an ESPHome proxy is configured or the stub transport is
    in play.
    """
    return Status(**await ask("status"))


TOOLS = (read_stream, search_packets, get_logs, get_connection_state, status)


def build_server() -> MCPServer:
    """Register the five tools on a fresh server.

    The tools stay plain module-level coroutines and are registered by calling the
    decorator rather than stacking it, so the tests can call them directly against
    a real socket without going through the protocol. What the protocol adds --
    schemas, structured content -- is tested separately, through this server.
    """
    server = MCPServer(name="ble-mcp-test", version=VERSION)
    for tool in TOOLS:
        server.tool(
            name=tool.__name__,
            description=f"{tool.__doc__.strip()}\n\n{_DISABLED_HINT}",
        )(tool)
    return server


def main() -> None:
    if "--check" in sys.argv:
        _check()
        return
    build_server().run("stdio")


def _check() -> None:
    """Answer "is the bridge up, and is it carrying traffic" without a Claude session.

    Exits 0 when a bridge answered, 2 when none did. It connects and reads; it
    starts nothing.
    """
    try:
        state = asyncio.run(_check_once())
    except BridgeDown as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2) from exc
    print(state)


async def _check_once() -> str:
    st = await status()
    conn = await get_connection_state()
    device = f"{conn.device_name} (session {conn.session})" if conn.held else "no device held"
    ring = f"{st.log_buffer_size} entries" if st.log_buffer_enabled else "DISABLED"
    return (
        f"bridge up on {st.socket_path}: ws {st.ws_host}:{st.ws_port}, "
        f"up {st.uptime_seconds:.0f}s, buffer {ring}, {device}, "
        f"{conn.packets_transmitted} TX / {conn.packets_received} RX"
    )


if __name__ == "__main__":
    main()
