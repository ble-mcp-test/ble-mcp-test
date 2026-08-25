"""The MCP shim, exercised against a real control socket.

Two processes have to agree on a socket path and a line format without sharing a
module: the shim is a single file so it can be run straight out of the checkout,
and it cannot import ble_bridge. That duplication is precisely the failure class
this repo designs against -- a waiter whose condition the emitter never satisfies
fails as a *timeout* and reads as "the bridge is down", which is also the shim's
legitimate message for a bridge that really is down. The two would be
indistinguishable.

So the agreement is checked mechanically here, by loading the real shim file and
pointing it at a real listener rather than at a fake. There is deliberately no mock
of the socket anywhere in this file: a green suite above a fake says nothing about
the wiring beneath it, and the wiring is the entire subject.
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import pathlib
import subprocess
import sys
import time

import pytest

from ble_bridge.config import Config, default_socket_path
from ble_bridge.control import ControlServer
from ble_bridge.log_buffer import INFO, RX, TX, LogBuffer
from ble_bridge.transport import DeviceInfo
from ble_bridge.ws.ownership import CommandPath

SHIM = pathlib.Path(__file__).resolve().parents[2] / "mcp-server" / "ble_mcp.py"

# Nothing in this module imports the MCP SDK at module scope, deliberately, and the
# `shim.ToolError` references below are why it does not need to. Importing it here
# happens at COLLECTION time -- before any test runs -- and the SDK pulls in pydantic
# and anyio, which is enough work to cost tests/stress/test_firehose.py a saturated
# tick. That test asserts saturated_ticks == 0 because a saturated tick voids the row
# as a statement about the relay, so an import in this file was failing a stress test
# in another one, reproducibly, with nothing in either file to suggest a connection.
# The SDK is still imported, by _load(), which runs at test time and after firehose.


def _load():
    """Import the shim file itself, not a copy of its contents.

    It goes into sys.modules before exec_module because pydantic resolves the
    models' forward references through the module's own namespace, and a module
    that is not registered has none to resolve through. A real invocation gets that
    for free -- it runs as `__main__` -- so skipping this here would fail a test
    against a shim that works perfectly when run.
    """
    spec = importlib.util.spec_from_file_location("ble_mcp_under_test", SHIM)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def shim():
    return _load()


@pytest.fixture
async def wired(shim, tmp_path, monkeypatch):
    """A live listener with the shim pointed at it."""
    buf = LogBuffer(100)
    path = CommandPath()
    sock = str(tmp_path / "wired.sock")
    monkeypatch.setenv("BLE_MCP_SOCKET_PATH", sock)
    srv = ControlServer(
        Config(socket_path=sock),
        log_buffer=buf,
        command_path=path,
        started_at=time.monotonic(),
    )
    await srv.start()
    try:
        yield shim, buf, path
    finally:
        await srv.stop()


# --- the duplicated rule ------------------------------------------------------


@pytest.mark.parametrize(
    "env",
    [
        {"XDG_RUNTIME_DIR": "/run/user/1000"},
        {"XDG_RUNTIME_DIR": ""},
        {"XDG_RUNTIME_DIR": "   "},
        {},
        {"BLE_MCP_SOCKET_PATH": "/tmp/explicit.sock"},
        {"BLE_MCP_SOCKET_PATH": "/tmp/explicit.sock", "XDG_RUNTIME_DIR": "/run/user/1000"},
    ],
    ids=["xdg", "blank-xdg", "whitespace-xdg", "neither", "override", "override-wins"],
)
def test_both_processes_resolve_the_same_socket_path(shim, env):
    """The mechanical half of the contract. One rule, two implementations, in two
    files that cannot import each other -- checked rather than eyeballed."""
    override = env.get("BLE_MCP_SOCKET_PATH")
    expected = override or default_socket_path(env)
    assert shim.resolve_socket_path(env) == expected


def test_the_shim_refuses_a_relative_override_the_way_the_bridge_does(shim):
    with pytest.raises(ValueError, match="absolute"):
        shim.resolve_socket_path({"BLE_MCP_SOCKET_PATH": "ble-bridge.sock"})


# --- the tools, end to end ----------------------------------------------------


async def test_read_stream_carries_frames_end_to_end(wired):
    shim, buf, _ = wired
    buf.push_packet(TX, bytes([0xA7, 0xB3]))
    buf.push_packet(RX, b"\x01")
    out = await shim.read_stream()
    assert [e.text for e in out.entries] == ["A7 B3", "01"]
    assert [e.direction for e in out.entries] == [TX, RX]
    assert out.next_cursor == 1
    assert out.buffer_enabled is True
    assert out.notice is None


async def test_read_stream_resumes_from_a_cursor(wired):
    shim, buf, _ = wired
    for i in range(4):
        buf.push_packet(TX, bytes([i]))
    first = await shim.read_stream(limit=2)
    second = await shim.read_stream(cursor=first.next_cursor)
    assert [e.id for e in second.entries] == [2, 3]


async def test_a_disabled_buffer_is_announced_not_empty(shim, tmp_path, monkeypatch):
    sock = str(tmp_path / "off.sock")
    monkeypatch.setenv("BLE_MCP_SOCKET_PATH", sock)
    srv = ControlServer(
        Config(socket_path=sock),
        log_buffer=LogBuffer(0),
        command_path=CommandPath(),
        started_at=time.monotonic(),
    )
    await srv.start()
    try:
        out = await shim.read_stream()
        assert out.entries == []
        assert out.buffer_enabled is False
        assert "BLE_MCP_LOG_BUFFER_SIZE" in out.notice
    finally:
        await srv.stop()


async def test_search_packets_finds_a_hex_pattern(wired):
    shim, buf, _ = wired
    buf.push_packet(TX, bytes([0xA7, 0xB3, 0x02]))
    buf.push_packet(RX, b"\x01")
    out = await shim.search_packets(hex_pattern="A7B3")
    assert out.count == 1
    assert out.entries[0].text == "A7 B3 02"


async def test_a_bad_hex_pattern_reaches_the_caller_as_an_error(wired):
    shim, _, _ = wired
    with pytest.raises(shim.BridgeRefused, match="hexadecimal"):
        await shim.search_packets(hex_pattern="zz")


async def test_get_logs_returns_log_lines_not_packets(wired):
    shim, buf, _ = wired
    buf.push_packet(TX, b"\xa7")
    buf.push_system(INFO, "the link came up")
    out = await shim.get_logs()
    assert [e.text for e in out.entries] == ["the link came up"]


async def test_get_connection_state_reports_the_owner(wired):
    shim, _, path = wired
    claim = path.claim("s1", force=False).ready(DeviceInfo(name="CS108", id="6C:79:B8:11:22:33"))
    try:
        out = await shim.get_connection_state()
        assert out.held is True
        assert out.session == "s1"
        assert out.device_name == "CS108"
        assert out.observer_count == 0
    finally:
        claim.release()


async def test_status_names_the_socket_and_no_http(wired):
    shim, _, _ = wired
    out = await shim.status()
    assert out.socket_path.endswith("wired.sock")
    assert not [f for f in type(out).model_fields if "http" in f.lower()]


# --- the MCP surface ----------------------------------------------------------


async def test_every_tool_is_registered_with_an_output_schema(shim):
    """structuredContent is an acceptance criterion, and a tool that quietly
    returns prose instead still passes a smoke test."""
    server = shim.build_server()
    tools = {t.name: t for t in await server.list_tools()}
    assert set(tools) == {
        "read_stream",
        "search_packets",
        "get_logs",
        "get_connection_state",
        "status",
    }
    for name, tool in tools.items():
        assert tool.output_schema is not None, f"{name} has no output schema"
        assert tool.description, f"{name} has no description for the model to read"


async def test_the_dropped_tools_are_not_registered(shim):
    """get_metrics had no Python backing and scan_devices needs a local radio.
    Both were dropped deliberately; this is what stops one drifting back in."""
    names = {t.name for t in await shim.build_server().list_tools()}
    assert "get_metrics" not in names
    assert "scan_devices" not in names
    assert "restart_rust_bridge" not in names


async def test_a_refusal_reaches_the_client_with_its_sentence_intact(wired):
    """The bridge writes its refusals to name what was wrong, and that text has to
    survive the SDK.

    The SDK forwards a ToolError's message and reduces every other exception to
    "Error executing tool <name>". So a refusal raised as a plain RuntimeError
    arrives as a hex search that failed for no stated reason -- which is how it
    behaved before BridgeRefused was made a ToolError, verified over real stdio.
    """
    shim, _, _ = wired
    with pytest.raises(shim.ToolError, match="hexadecimal"):
        await shim.build_server().call_tool("search_packets", {"hex_pattern": "zz"})


async def test_bridge_down_reaches_the_client_with_its_sentence_intact(shim, tmp_path, monkeypatch):
    """Same guard on the other message. "no bridge", "wrong socket" and "bridge
    wedged" are three different things to go and fix, and a caller told only that a
    tool failed would look in the wrong place."""
    monkeypatch.setenv("BLE_MCP_SOCKET_PATH", str(tmp_path / "nothing.sock"))
    with pytest.raises(shim.ToolError, match="nothing.sock") as exc:
        await shim.build_server().call_tool("status", {})
    assert "not start" in str(exc.value).lower()


async def test_a_tool_call_returns_structured_content(wired):
    shim, buf, _ = wired
    buf.push_packet(TX, b"\xa7")
    result = await shim.build_server().call_tool("read_stream", {})
    assert result.is_error is False
    assert result.structured_content["entries"][0]["text"] == "A7"


# --- the bridge being down ----------------------------------------------------


async def test_a_dead_socket_is_reported_as_the_bridge_being_down(shim, tmp_path, monkeypatch):
    monkeypatch.setenv("BLE_MCP_SOCKET_PATH", str(tmp_path / "nothing.sock"))
    with pytest.raises(shim.BridgeDown) as exc:
        await shim.status()
    assert "nothing.sock" in str(exc.value)


async def test_the_down_message_says_it_will_not_start_one(shim, tmp_path, monkeypatch):
    monkeypatch.setenv("BLE_MCP_SOCKET_PATH", str(tmp_path / "nothing.sock"))
    with pytest.raises(shim.BridgeDown) as exc:
        await shim.status()
    assert "not start" in str(exc.value).lower()


def test_the_shim_exits_rather_than_starting_a_bridge(tmp_path):
    """Run the real file the way a registration runs it. It must report the bridge
    as down, exit non-zero, and leave nothing behind -- a debugging tool that
    launches the thing it inspects will eventually launch a second writer alongside
    a running soak, which is the exact hazard the ownership model exists for."""
    sock = tmp_path / "absent.sock"
    proc = subprocess.run(
        [sys.executable, str(SHIM), "--check"],
        capture_output=True,
        text=True,
        timeout=120,
        env=dict(os.environ, BLE_MCP_SOCKET_PATH=str(sock)),
    )
    assert proc.returncode != 0
    assert "absent.sock" in proc.stderr
    assert not sock.exists()


async def test_check_reports_a_live_bridge_and_exits_zero(wired, tmp_path):
    shim, buf, _ = wired
    buf.push_packet(TX, b"\xa7")
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        str(SHIM),
        "--check",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=dict(os.environ),
    )
    stdout, _ = await asyncio.wait_for(proc.communicate(), 120)
    assert proc.returncode == 0
    assert "wired.sock" in stdout.decode()
