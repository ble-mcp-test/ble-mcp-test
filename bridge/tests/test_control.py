"""The unix socket the MCP shim reads. A contract, not an implementation detail.

Every test here drives a real AF_UNIX socket rather than calling handlers directly,
because the half that breaks in this repo is the framing. A reader waiting on a
condition the writer never produces fails as a *timeout*, so it presents as
slowness rather than as an error, and nothing in a handler-level test would show it.

The other design rule on show here is the refusal. Two of these tests assert that
the server says no -- to an unknown op and to an unknown argument -- rather than
doing something reasonable. A silently dropped filter returns the wrong rows while
looking exactly like data.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import socket
import time

import pytest

from ble_bridge.config import Config, from_env
from ble_bridge.control import MAX_LINE_BYTES, ControlServer
from ble_bridge.log_buffer import ERROR, INFO, RX, TX, LogBuffer
from ble_bridge.mock_version import MockVersionWatch, expected_mock_version
from ble_bridge.transport import DeviceInfo
from ble_bridge.ws.ownership import CommandPath


def _a_free_port() -> int:
    """A free port INSIDE the accepted range, not merely a free port.

    `bind(("127.0.0.1", 0))` asks the OS for one, and the OS assigns from the
    ephemeral range -- which config now rejects, because a listen port in that
    range can be transiently stolen by an outbound socket's source port. So the
    obvious helper hands back exactly the kind of port the bridge refuses.
    Probe within the range instead, and fail loudly rather than returning an
    unusable one.
    """
    for candidate in range(20000, 20100):
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", candidate))
            except OSError:
                continue
            return candidate
    raise RuntimeError("no free port in 20000-20099 for the test bridge")


#: An explicit port, because Config no longer carries a default one. The value
#: is arbitrary; what these tests pin is that `status` reports the CONFIGURED
#: port rather than a constant of its own.
CONTROL_TEST_PORT = 25153


def _make(path, buffer=None, command_path=None, mock_versions=None):
    return ControlServer(
        Config(ws_port=CONTROL_TEST_PORT, socket_path=str(path)),
        log_buffer=buffer if buffer is not None else LogBuffer(100),
        command_path=command_path if command_path is not None else CommandPath(),
        mock_versions=mock_versions if mock_versions is not None else MockVersionWatch(),
        started_at=time.monotonic(),
    )


@pytest.fixture
async def server(tmp_path):
    buf = LogBuffer(100)
    path = CommandPath()
    srv = _make(tmp_path / "b.sock", buf, path)
    await srv.start()
    try:
        yield srv, buf, path
    finally:
        await srv.stop()


@pytest.fixture
async def versioned(tmp_path):
    """A control server whose mock-version watch the test can drive directly."""
    watch = MockVersionWatch()
    path = CommandPath()
    srv = _make(tmp_path / "v.sock", command_path=path, mock_versions=watch)
    await srv.start()
    try:
        yield srv, path, watch
    finally:
        await srv.stop()


async def _ask(srv, op, **args):
    reader, writer = await asyncio.open_unix_connection(srv.path)
    try:
        writer.write((json.dumps({"op": op, "args": args}) + "\n").encode())
        await writer.drain()
        return json.loads(await asyncio.wait_for(reader.readline(), 5))
    finally:
        writer.close()
        with contextlib.suppress(ConnectionResetError, BrokenPipeError):
            await writer.wait_closed()


async def test_the_socket_is_owner_only(server):
    """0600 is the entire authorization story on this path. mcp-http-transport.ts
    set `origin: '*'` on a 0.0.0.0 bind with the token consulted only if set;
    nothing here needs a token because nothing else can open the file."""
    srv, _, _ = server
    assert os.stat(srv.path).st_mode & 0o777 == 0o600


async def test_read_stream_returns_the_interleaved_record(server):
    srv, buf, _ = server
    buf.push_packet(TX, b"\xa7")
    buf.push_system(ERROR, "write failed")
    buf.push_packet(RX, b"\xb3")
    reply = await _ask(srv, "read_stream")
    assert reply["ok"] is True
    assert [e["direction"] for e in reply["result"]["entries"]] == [TX, ERROR, RX]
    assert reply["result"]["next_cursor"] == 2


async def test_read_stream_is_cursored(server):
    srv, buf, _ = server
    for i in range(5):
        buf.push_packet(TX, bytes([i]))
    reply = await _ask(srv, "read_stream", cursor=2)
    assert [e["id"] for e in reply["result"]["entries"]] == [3, 4]


async def test_a_cursor_at_the_head_returns_nothing_and_keeps_its_place(server):
    """The polling case. next_cursor must not go backwards to null when the
    stream is merely quiet, or the next call re-reads the whole ring."""
    srv, buf, _ = server
    for i in range(3):
        buf.push_packet(TX, bytes([i]))
    reply = await _ask(srv, "read_stream", cursor=2)
    assert reply["result"]["entries"] == []
    assert reply["result"]["next_cursor"] == 2


async def test_read_stream_reports_the_gap_a_late_reader_fell_into(server):
    """An evicted entry is absent rather than renumbered, which is honest but
    invisible. dropped_before is what makes the gap legible."""
    srv, buf, _ = server
    for i in range(150):
        buf.push_packet(TX, bytes([i % 256]))
    reply = await _ask(srv, "read_stream", cursor=3)
    assert reply["result"]["dropped_before"] == 50


async def test_a_caught_up_reader_reports_no_gap(server):
    srv, buf, _ = server
    for i in range(5):
        buf.push_packet(TX, bytes([i]))
    reply = await _ask(srv, "read_stream", cursor=2)
    assert reply["result"]["dropped_before"] is None


async def test_read_stream_says_so_when_the_buffer_is_disabled(tmp_path):
    """An empty list from a disabled ring is indistinguishable from a silent
    device. It has to say which one it is."""
    srv = _make(tmp_path / "d.sock", LogBuffer(0))
    await srv.start()
    try:
        reply = await _ask(srv, "read_stream")
        assert reply["result"]["buffer_enabled"] is False
        assert "BLE_MCP_LOG_BUFFER_SIZE" in reply["result"]["notice"]
    finally:
        await srv.stop()


async def test_a_live_buffer_carries_no_notice(server):
    srv, _, _ = server
    reply = await _ask(srv, "read_stream")
    assert reply["result"]["buffer_enabled"] is True
    assert reply["result"]["notice"] is None


async def test_get_logs_excludes_packets(server):
    srv, buf, _ = server
    buf.push_packet(TX, b"\xa7")
    buf.push_system(INFO, "hello")
    reply = await _ask(srv, "get_logs")
    assert [e["text"] for e in reply["result"]["entries"]] == ["hello"]


async def test_search_packets_matches_hex(server):
    srv, buf, _ = server
    buf.push_packet(TX, bytes([0xA7, 0xB3]))
    buf.push_packet(RX, b"\x01")
    reply = await _ask(srv, "search_packets", hex_pattern="a7b3")
    assert reply["result"]["count"] == 1
    assert reply["result"]["entries"][0]["text"] == "A7 B3"


async def test_search_packets_refuses_a_non_hex_pattern(server):
    srv, _, _ = server
    reply = await _ask(srv, "search_packets", hex_pattern="zz")
    assert reply["ok"] is False
    assert "hexadecimal" in reply["reason"]


async def test_search_packets_needs_its_pattern(server):
    srv, _, _ = server
    reply = await _ask(srv, "search_packets")
    assert reply["ok"] is False
    assert "hex_pattern" in reply["reason"]


async def test_get_connection_state_when_nothing_holds_the_path(server):
    srv, _, _ = server
    result = (await _ask(srv, "get_connection_state"))["result"]
    assert result["held"] is False
    assert result["session"] is None
    assert result["observer_count"] == 0


async def test_get_connection_state_reports_the_owner_and_its_observers(server):
    srv, buf, path = server
    claim = path.claim("s1", force=False).ready(DeviceInfo(name="CS108", id="6C:79:B8:11:22:33"))
    path.observe("s2")
    buf.push_packet(TX, b"\x01")
    buf.push_packet(RX, b"\x02")
    try:
        result = (await _ask(srv, "get_connection_state"))["result"]
        assert result["held"] is True
        assert result["session"] == "s1"
        assert result["device_name"] == "CS108"
        assert result["device_id"] == "6C:79:B8:11:22:33"
        assert result["ready"] is True
        assert result["observer_count"] == 1
        assert (result["packets_transmitted"], result["packets_received"]) == (1, 1)
    finally:
        claim.release()


async def test_get_connection_state_reports_the_holders_mock_version(versioned):
    srv, path, _ = versioned
    claim = path.claim("s1", force=False, mock_version="0.12.0")
    try:
        result = (await _ask(srv, "get_connection_state"))["result"]
        assert result["mock_version"] == "0.12.0"
        assert result["mock_version_expected"] == expected_mock_version()
        assert result["mock_version_match"] is False
    finally:
        claim.release()


async def test_get_connection_state_reports_a_healthy_holder_as_matching(versioned):
    srv, path, _ = versioned
    claim = path.claim("s1", force=False, mock_version=expected_mock_version())
    try:
        result = (await _ask(srv, "get_connection_state"))["result"]
        assert result["mock_version_match"] is True
    finally:
        claim.release()


async def test_get_connection_state_says_unknown_rather_than_mismatch_when_idle(versioned):
    """An empty command path has no version to check, and `null` says so.

    `false` here would be a lie a consumer cannot detect: it would read as
    "checked, and they differ" on a bridge nobody is even connected to.
    """
    srv, _, _ = versioned
    result = (await _ask(srv, "get_connection_state"))["result"]
    assert result["mock_version"] is None
    assert result["mock_version_match"] is None


async def test_get_connection_state_says_unknown_when_the_client_sent_no_version(versioned):
    srv, path, _ = versioned
    claim = path.claim("s1", force=False)
    try:
        result = (await _ask(srv, "get_connection_state"))["result"]
        assert result["mock_version"] is None
        assert result["mock_version_match"] is None
    finally:
        claim.release()


async def test_status_carries_the_lifetime_mismatch_counter(versioned):
    """The field a soak watchdog keys on, because it cannot be missed between polls.

    `get_connection_state` reads `held: false` in the gap between test
    repetitions, so a snapshot only catches a mismatch if the poll lands
    mid-rep. A monotonic counter is comparable across two polls whatever they
    landed on.
    """
    srv, _, watch = versioned
    assert (await _ask(srv, "status"))["result"]["mock_version_mismatches"] == 0
    watch.observe("0.0.1-nope")
    watch.observe("0.0.1-nope")
    assert (await _ask(srv, "status"))["result"]["mock_version_mismatches"] == 2


async def test_status_reports_the_resolved_configuration(server):
    srv, _, _ = server
    result = (await _ask(srv, "status"))["result"]
    assert result["ws_port"] == CONTROL_TEST_PORT
    assert result["socket_path"] == srv.path
    assert result["log_buffer_enabled"] is True
    assert result["uptime_seconds"] >= 0
    assert result["esphome_configured"] is False


async def test_status_carries_no_http_surface(server):
    """The acceptance criterion, executed. mcpTransports.httpPort and httpAuth
    were fields on the TS status payload; nothing here reinstates them."""
    srv, _, _ = server
    result = (await _ask(srv, "status"))["result"]
    # socket_path is excluded because pytest names tmp_path after this test, so it
    # contains "http" -- the assertion would then be about the directory name
    # rather than about the payload.
    payload = {k: v for k, v in result.items() if k != "socket_path"}
    assert "http" not in json.dumps(payload).lower()
    assert not [k for k in result if "http" in k.lower()]


async def test_status_names_the_esphome_target_when_one_is_configured(tmp_path):
    config = from_env(
        {
            "BLE_MCP_WS_PORT": str(CONTROL_TEST_PORT),
            "ESPHOME_PROXY_HOST": "192.168.50.170",
            "BLE_MCP_DEVICE_MAC": "6c:79:b8:11:22:33",
            "BLE_MCP_SOCKET_PATH": str(tmp_path / "e.sock"),
        }
    )
    srv = ControlServer(
        config,
        log_buffer=LogBuffer(10),
        command_path=CommandPath(),
        mock_versions=MockVersionWatch(),
        started_at=time.monotonic(),
    )
    await srv.start()
    try:
        result = (await _ask(srv, "status"))["result"]
        assert result["esphome_configured"] is True
        assert result["esphome_proxy"] == "192.168.50.170:6053"
        assert result["device_mac"] == "6C:79:B8:11:22:33"
    finally:
        await srv.stop()


async def test_an_unknown_op_is_refused_by_name(server):
    """get_metrics and scan_devices were dropped deliberately. The refusal names
    what exists, so the next person does not conclude the socket is broken."""
    srv, _, _ = server
    reply = await _ask(srv, "get_metrics")
    assert reply["ok"] is False
    assert "get_metrics" in reply["reason"]
    assert "read_stream" in reply["reason"]


async def test_an_unknown_argument_is_refused_rather_than_ignored(server):
    srv, _, _ = server
    reply = await _ask(srv, "read_stream", limitt=5)
    assert reply["ok"] is False
    assert "limitt" in reply["reason"]


async def test_an_out_of_range_limit_is_refused_rather_than_clamped(server):
    """A clamp is a fallback: the caller keeps reading their own 5000 back and
    believing it took effect."""
    srv, _, _ = server
    reply = await _ask(srv, "read_stream", limit=5000)
    assert reply["ok"] is False
    assert "5000" in reply["reason"]


async def test_malformed_json_gets_an_answer_rather_than_silence(server):
    srv, _, _ = server
    reader, writer = await asyncio.open_unix_connection(srv.path)
    try:
        writer.write(b"{not json\n")
        await writer.drain()
        reply = json.loads(await asyncio.wait_for(reader.readline(), 5))
        assert reply["ok"] is False
    finally:
        writer.close()
        await writer.wait_closed()


async def test_a_request_that_is_not_an_object_is_refused(server):
    srv, _, _ = server
    reader, writer = await asyncio.open_unix_connection(srv.path)
    try:
        writer.write(b"[1, 2, 3]\n")
        await writer.drain()
        reply = json.loads(await asyncio.wait_for(reader.readline(), 5))
        assert reply["ok"] is False
    finally:
        writer.close()
        await writer.wait_closed()


async def test_one_connection_serves_many_requests(server):
    srv, _, _ = server
    reader, writer = await asyncio.open_unix_connection(srv.path)
    try:
        for _ in range(3):
            writer.write(b'{"op": "status"}\n')
            await writer.drain()
            assert json.loads(await asyncio.wait_for(reader.readline(), 5))["ok"] is True
    finally:
        writer.close()
        await writer.wait_closed()


async def test_an_overlong_line_is_refused_rather_than_buffered_forever(server):
    """The waiter-that-cannot-be-satisfied guard: a client that never sends a
    newline must not pin a handler for the life of the process."""
    srv, _, _ = server
    reader, writer = await asyncio.open_unix_connection(srv.path)
    try:
        writer.write(b'{"op": "status", "args": {"x": "' + b"A" * (MAX_LINE_BYTES + 10))
        await writer.drain()
        reply = json.loads(await asyncio.wait_for(reader.readline(), 5))
        assert reply["ok"] is False
        assert "too long" in reply["reason"]
    finally:
        writer.close()
        with contextlib.suppress(ConnectionResetError, BrokenPipeError):
            await writer.wait_closed()


async def test_a_stale_socket_file_is_replaced(tmp_path):
    """kill -9 leaves the file behind. Refusing to start over a corpse would make
    every hard restart a manual cleanup."""
    path = tmp_path / "stale.sock"
    first = _make(path)
    await first.start()
    first._server.close()  # drop the listener, leave the file on disk
    await first._server.wait_closed()
    assert os.path.exists(path)

    second = _make(path)
    await second.start()
    try:
        assert (await _ask(second, "status"))["ok"] is True
    finally:
        await second.stop()


async def test_a_live_socket_is_not_stolen(tmp_path):
    """Two bridges on one radio is the hazard the ownership model exists to
    prevent. The second must refuse rather than take the socket over."""
    path = tmp_path / "live.sock"
    first = _make(path)
    await first.start()
    second = _make(path)
    try:
        with pytest.raises(OSError, match="already listening"):
            await second.start()
        assert (await _ask(first, "status"))["ok"] is True
    finally:
        await first.stop()


async def test_a_path_occupied_by_an_ordinary_file_is_refused(tmp_path):
    path = tmp_path / "notasocket"
    path.write_text("hello")
    srv = _make(path)
    with pytest.raises(OSError, match="not a socket"):
        await srv.start()
    assert path.read_text() == "hello"


async def test_stopping_removes_the_socket_file(tmp_path):
    srv = _make(tmp_path / "gone.sock")
    await srv.start()
    await srv.stop()
    assert not os.path.exists(srv.path)


async def test_a_missing_parent_directory_is_created(tmp_path):
    srv = _make(tmp_path / "nested" / "deeper" / "b.sock")
    await srv.start()
    try:
        assert (await _ask(srv, "status"))["ok"] is True
    finally:
        await srv.stop()


async def test_the_daemon_serves_the_relay_and_the_socket_together(tmp_path, monkeypatch):
    """The listener belongs to the daemon, not to a test harness. If __main__
    forgets to start it, every MCP tool reports the bridge as down while the relay
    is perfectly fine -- an upstream omission naming a downstream subsystem."""
    import ble_bridge.__main__ as entry

    monkeypatch.setenv("BLE_MCP_SOCKET_PATH", str(tmp_path / "run.sock"))
    # A concrete free port, not 0: config refuses 0 as outside 1-65535, and the
    # relay's binding is incidental to what this test is about.
    monkeypatch.setenv("BLE_MCP_WS_PORT", str(_a_free_port()))
    config = from_env(dict(os.environ))
    task = asyncio.create_task(entry._run(config, LogBuffer(100)))
    try:
        for _ in range(100):
            if os.path.exists(config.socket_path):
                break
            await asyncio.sleep(0.05)
        reader, writer = await asyncio.open_unix_connection(config.socket_path)
        writer.write(b'{"op": "status"}\n')
        await writer.drain()
        reply = json.loads(await asyncio.wait_for(reader.readline(), 5))
        assert reply["ok"] is True
        assert reply["result"]["socket_path"] == config.socket_path
        writer.close()
        await writer.wait_closed()
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    assert not os.path.exists(config.socket_path)


async def test_status_carries_process_identity_and_code_currency(server):
    """The two questions consumers were answering through /proc and systemd.

    TRA-1204: both were being derived by reaching past this contract into the
    daemon's internals. Co-location made that possible; a second bridge on a
    container is where it stops working.
    """
    from ble_bridge import identity

    srv, _, _ = server
    result = (await _ask(srv, "status"))["result"]
    assert result["instance_id"] == identity.INSTANCE_ID
    assert result["code_fingerprint"] == identity.CODE_FINGERPRINT
    assert result["code_source_root"] == identity.SOURCE_ROOT


async def test_status_still_carries_what_platform_reads(server):
    """TRA-1204 is add-only on the wire. Platform's soak watchdog (TRA-1203) reads
    these by name, so a rename here is a cross-repo break that this repo's suite
    would otherwise pass straight through."""
    srv, _, _ = server
    result = (await _ask(srv, "status"))["result"]
    for field in ("uptime_seconds", "esphome_configured", "esphome_proxy", "device_mac"):
        assert field in result, field


async def test_instance_id_and_uptime_are_both_present_and_neither_replaces_the_other(server):
    """Shipped as a pair, deliberately. instance_id answers "is this a different
    process"; the elapsed-time arithmetic over uptime_seconds answers "has this
    process been running for the whole interval I measured". A host suspend moves
    only the second, so a consumer that drops either loses a real signal.

    Asserted together in one test so that deleting one field fails a test whose
    name says why both are here."""
    srv, _, _ = server
    result = (await _ask(srv, "status"))["result"]
    assert isinstance(result["instance_id"], str) and result["instance_id"]
    assert isinstance(result["uptime_seconds"], float)
