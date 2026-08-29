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
from typing import Any, get_type_hints

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import BaseModel, ConfigDict, Field

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


class BridgeDown(ToolError):
    """No bridge is listening on the socket.

    A `ToolError` rather than a bare exception, and that is load-bearing: the SDK
    forwards a ToolError's message to the client and reduces anything else to
    "Error executing tool <name>". The whole point of these messages is that they
    say which of "no bridge", "wrong socket" and "bridge wedged" happened -- and a
    caller told only that a tool failed would go looking in the wrong place.
    """


class BridgeRefused(ToolError):
    """The bridge answered, and the answer was no. Its sentence, verbatim.

    Also a ToolError, for the same reason: the control socket's refusals are
    written to name what was wrong ("that pattern is not hexadecimal, so it can
    never match"), and swallowing them would leave the caller with a hex search
    that failed for no stated reason.
    """


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
# and every reply comes back as structuredContent.


class BridgeReply(BaseModel):
    """Base for every reply model: strict about what is missing, open to what is new.

    The two directions are not symmetric and both are deliberate.

    **A declared field the bridge stops sending fails validation here.** That is the
    drift this file's typed models exist to catch, and it stays.

    **A field the bridge sends that this shim does not declare passes through.**
    Pydantic's default would drop it, and the comment above this block used to claim
    the models caught "a drift in the socket contract" -- true of a missing field,
    false of an added one, and the false half is the one that bit. On 2026-08-29 a
    shim 24 hours older than the daemon silently dropped `instance_id`,
    `code_fingerprint` and `code_source_root`; the reader concluded they had not
    shipped.

    What made that misleading was not the absence but its NEIGHBOUR. `version` was
    already declared, so it passed through reading `0.13.0` -- a freshly moved value
    sitting beside three that were simply gone, which reads as "the daemon is current
    and those fields do not exist" rather than "my view is stale". Pass-through turns
    a fabricated absence into an undocumented presence, and an undocumented field is
    self-evidently the reader's problem in a way a missing one is not.

    This cannot help the upgrade that introduces it -- the shim doing the dropping is
    always the one that predates the fix. It is ambiguous exactly once, then
    permanently better, and there will be more fields.

    `extra="allow"` also sets `additionalProperties: true` on the generated
    outputSchema, which matters: the model and the schema are separate gates, and
    extras surviving pydantic would still be dropped by a client validating
    structuredContent against a schema that forbade them.
    """

    model_config = ConfigDict(extra="allow")


class Entry(BridgeReply):
    """One packet or one log line, in the order the bridge saw it."""

    id: int = Field(description="Monotonic id. Pass the last one back as `cursor`.")
    timestamp: str
    direction: str = Field(description="TX or RX for a packet; a log level for a log line.")
    text: str = Field(description="Uppercase spaced hex for a packet, the message for a log line.")
    size: int = Field(description="Payload bytes. 0 for a log line.")
    is_packet: bool


class StreamResult(BridgeReply):
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


class SearchResult(BridgeReply):
    entries: list[Entry]
    count: int
    pattern: str
    buffer_enabled: bool
    buffer_size: int
    notice: str | None


class ConnectionState(BridgeReply):
    held: bool = Field(description="Whether any connection owns the command path.")
    session: str | None
    ready: bool = Field(description="Whether the owner's device link is up.")
    device_name: str | None
    device_id: str | None
    observer_count: int = Field(description="Read-only connections attached to the owner.")
    packets_transmitted: int = Field(description="Lifetime total for the bridge process.")
    packets_received: int = Field(description="Lifetime total for the bridge process.")
    mock_version: str | None = Field(
        description="The npm version of the browser mock that OWNS the command path, "
        "as it announced itself on connect. Null when nothing holds the path, or when "
        "the client connected without the mock injected. Observers are not reported "
        "here -- a stray tab running an old build must not be attributed to the "
        "writer actually driving the device."
    )
    mock_version_expected: str | None = Field(
        description="The npm version this bridge ships with. Null if it could not be "
        "resolved from package.json."
    )
    mock_version_match: bool | None = Field(
        description="Three-valued, and the distinction is the whole point. False means "
        "CHECKED AND DIFFERENT. Null means could not check -- nothing connected, no "
        "version announced, or ours unresolvable. Never read null as agreement: a "
        "150-rep hardware run was analysed before anyone noticed the mock was a minor "
        "version behind, because the only signal was a log line nobody consumed."
    )


class Status(BridgeReply):
    version: str = Field(
        description="The released version of the mock and bridge. NOT a code-currency "
        "signal: a release number moves on release and code moves on merge, so two "
        "daemons at the same version can be serving different code."
    )
    instance_id: str = Field(
        description="This bridge process, for as long as it lives. Different after "
        "any restart, so comparing it is an equality check rather than arithmetic."
    )
    code_fingerprint: str = Field(
        description="Hash of the .py files the process loaded at start. Compare "
        "against a fresh fingerprint of code_source_root to tell whether the daemon "
        "predates the code."
    )
    code_source_root: str = Field(
        description="The directory that was fingerprinted. Fingerprint THIS tree, "
        "not your own -- judging a daemon against the current tree reports a current "
        "daemon as stale whenever a worktree has commits touching bridge/."
    )
    uptime_seconds: float = Field(
        description="Monotonic seconds since process start. Not superseded by "
        "instance_id: CLOCK_MONOTONIC does not advance across host suspend, so "
        "elapsed-time arithmetic over this catches a gap that instance_id cannot."
    )
    mock_version_mismatches: int = Field(
        description="Connections seen since start whose mock version differed from "
        "this bridge's. Monotonic, reset only by a restart. This is the field to poll: "
        "get_connection_state's snapshot reads null in the gap between test "
        "repetitions, so it is only unmissable if the poll lands mid-run. Baseline "
        "this at the start of a soak and abort if it moves."
    )
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

    `mock_version_match` is three-valued: false means the owner's browser mock is
    a different version from this bridge's, null means the question could not be
    asked. Read null as "unknown", never as agreement. A difference is reported,
    not refused -- whether it matters is the consumer's call, and `status` carries
    the counter to poll if you cannot guarantee sampling mid-connection.
    """
    return ConnectionState(**await ask("get_connection_state"))


async def status() -> Status:
    """The bridge's resolved configuration and how long it has been up.

    Useful mostly for confirming that the bridge you are reading is the one you
    think you are reading: the WebSocket bind, the log level actually in force, the
    ring size, and whether an ESPHome proxy is configured or the stub transport is
    in play.

    `mock_version_mismatches` is the field to poll during a long run: monotonic
    for the life of the process, so comparing two samples catches a stale browser
    mock that connected and disconnected between them. `get_connection_state`
    cannot -- its snapshot is null whenever nothing is connected.
    """
    return Status(**await ask("status"))


TOOLS = (read_stream, search_packets, get_logs, get_connection_state, status)


def _takes_disabled_hint(tool) -> bool:
    """Does an empty result from this tool mean anything ambiguous?

    Only for the tools whose result is a slice of the ring, and that is decided by
    asking their return model whether it carries `buffer_enabled` -- not by a list
    of names kept alongside. A hand-list drifts: a new buffer-backed tool gets added
    without its warning, and nothing says so.

    It used to go on every tool. `status` reports `log_buffer_enabled` outright and
    `get_connection_state`'s packet counters are lifetime totals that keep counting
    while the ring is off, so neither has an ambiguous empty to warn about -- and a
    warning that fires where it does not apply trains the reader to skip the line,
    which is how the one real instance goes past unremarked.
    """
    # get_type_hints rather than __annotations__: `from __future__ import
    # annotations` makes every annotation in this file a string, and a string has
    # no model_fields. Reading the raw dict would raise here rather than answer
    # wrongly, which is the only reason it is not also a silent bug.
    return "buffer_enabled" in get_type_hints(tool)["return"].model_fields



def build_server() -> MCPServer:
    """Register the five tools on a fresh server.

    The tools stay plain module-level coroutines and are registered by calling the
    decorator rather than stacking it, so the tests can call them directly against
    a real socket without going through the protocol. What the protocol adds --
    schemas, structured content -- is tested separately, through this server.
    """
    server = MCPServer(name="ble-mcp-test", version=VERSION)
    for tool in TOOLS:
        doc = tool.__doc__.strip()
        if _takes_disabled_hint(tool):
            doc = f"{doc}\n\n{_DISABLED_HINT}"
        server.tool(name=tool.__name__, description=doc)(tool)
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
    # Appended only when the count has moved. A clause on every healthy line is
    # one nobody reads, which is exactly how the original warning went
    # unremarked through 150 hardware reps.
    stale = (
        f", {st.mock_version_mismatches} mock version mismatches since start"
        if st.mock_version_mismatches
        else ""
    )
    return (
        f"bridge up on {st.socket_path}: ws {st.ws_host}:{st.ws_port}, "
        f"up {st.uptime_seconds:.0f}s, buffer {ring}, {device}, "
        f"{conn.packets_transmitted} TX / {conn.packets_received} RX{stale}"
    )


if __name__ == "__main__":
    main()
