"""What a consumer can learn about the connected mock's version, over MCP.

TRA-1200's 150-rep hardware measurement ran browser mock 0.12.0 against bridge
0.13.0. The bridge warned on every one of the 150 connections and nothing
consumed the warning, so the run completed and was analysed before anyone knew.
Every repo-level check -- clean tree, correct lockfile, correct node_modules
symlink -- was right, and every one of them was answering a question about the
tree rather than about the running process.

So the subject here is the wiring, and it is tested through a real WebSocket into
a real control socket rather than by calling the reporter directly. A watch that
counts perfectly while the relay increments a different instance would pass every
unit test in test_mock_version.py and report zero forever, which is precisely the
shape of the failure being fixed.

Two fields, doing two jobs:

* `get_connection_state` answers point-in-time, for the command-path holder.
* `status` carries a monotonic lifetime counter, because a snapshot is missable.
  Between test repetitions the path reads `held: false`; with ~27s reps against a
  300s poll most samples land in that gap. A counter is comparable across two
  polls whatever they landed on.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time

import pytest
import websockets

from ble_bridge.config import Config
from ble_bridge.control import ControlServer
from ble_bridge.log_buffer import LogBuffer
from ble_bridge.mock_version import expected_mock_version
from ble_bridge.transport import StubTransport
from ble_bridge.ws import protocol as p
from ble_bridge.ws.server import BridgeServer

REQUIRED = "service=180a&write=2a01&notify=2a02"
STALE = "0.0.1-nope"


@pytest.fixture
async def stack(tmp_path):
    """A relay and the MCP control socket that reads its state.

    Wired exactly as `__main__._run` wires them: the control server is handed the
    relay's own command path and mock-version watch, never fresh ones.
    """
    server = BridgeServer(Config(ws_host="127.0.0.1", ws_port=0), lambda _params: StubTransport())
    port = await server.start()
    assert port != 8080
    control = ControlServer(
        Config(socket_path=str(tmp_path / "stack.sock")),
        log_buffer=LogBuffer(100),
        command_path=server.command_path,
        mock_versions=server.mock_versions,
        started_at=time.monotonic(),
    )
    await control.start()
    try:
        yield f"ws://127.0.0.1:{port}", control
    finally:
        await control.stop()
        await server.stop()


async def _ask(control, op):
    reader, writer = await asyncio.open_unix_connection(control.path)
    try:
        writer.write((json.dumps({"op": op}) + "\n").encode())
        await writer.drain()
        reply = json.loads(await asyncio.wait_for(reader.readline(), 5))
    finally:
        writer.close()
        with contextlib.suppress(ConnectionResetError, BrokenPipeError):
            await writer.wait_closed()
    assert reply["ok"] is True, reply
    return reply["result"]


async def test_a_stale_mock_is_visible_while_it_holds_the_path(stack):
    url, control = stack
    async with websockets.connect(f"{url}/?{REQUIRED}&_mv={STALE}") as ws:
        assert json.loads(await ws.recv())["type"] == p.MSG_CONNECTED
        state = await _ask(control, "get_connection_state")
    assert state["mock_version"] == STALE
    assert state["mock_version_expected"] == expected_mock_version()
    assert state["mock_version_match"] is False


async def test_a_current_mock_reports_a_match_rather_than_silence(stack):
    """The healthy case has to be positively distinguishable from the unknown one.

    `mock_version_match: null` on a correctly-versioned client would leave a
    consumer unable to assert anything, which is the state TRA-1200 was already in.
    """
    url, control = stack
    async with websockets.connect(f"{url}/?{REQUIRED}&_mv={expected_mock_version()}") as ws:
        assert json.loads(await ws.recv())["type"] == p.MSG_CONNECTED
        state = await _ask(control, "get_connection_state")
    assert state["mock_version_match"] is True


async def test_a_client_that_sent_no_version_reads_unknown_not_mismatch(stack):
    url, control = stack
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        assert json.loads(await ws.recv())["type"] == p.MSG_CONNECTED
        state = await _ask(control, "get_connection_state")
    assert state["mock_version"] is None
    assert state["mock_version_match"] is None


async def test_the_counter_outlives_the_connection_that_moved_it(stack):
    """The property the snapshot does not have.

    By the time this reads `status` the offending connection is gone and
    `get_connection_state` is back to nulls -- which is exactly the sample a
    300s poll takes against 27s repetitions.
    """
    url, control = stack
    async with websockets.connect(f"{url}/?{REQUIRED}&_mv={STALE}") as ws:
        await ws.recv()
    assert (await _ask(control, "get_connection_state"))["mock_version"] is None
    assert (await _ask(control, "status"))["mock_version_mismatches"] == 1


async def test_the_counter_moves_once_per_connection(stack):
    url, control = stack
    for _ in range(3):
        async with websockets.connect(f"{url}/?{REQUIRED}&_mv={STALE}") as ws:
            await ws.recv()
    assert (await _ask(control, "status"))["mock_version_mismatches"] == 3


async def test_traffic_on_one_connection_does_not_move_the_counter(stack):
    """Once per connection, not once per packet. A per-packet counter would be an
    activity measure wearing a version check's name."""
    url, control = stack
    async with websockets.connect(f"{url}/?{REQUIRED}&_mv={STALE}") as ws:
        await ws.recv()
        for _ in range(5):
            await ws.send(p.encode_data(bytes([0x02, 0x03])))
        await asyncio.sleep(0.1)
        assert (await _ask(control, "status"))["mock_version_mismatches"] == 1


async def test_a_healthy_connection_leaves_the_counter_alone(stack):
    url, control = stack
    async with websockets.connect(f"{url}/?{REQUIRED}&_mv={expected_mock_version()}") as ws:
        await ws.recv()
    assert (await _ask(control, "status"))["mock_version_mismatches"] == 0


async def test_a_connection_with_no_version_leaves_the_counter_alone(stack):
    """Unknown is not a mismatch, on the counter as on the snapshot. Counting it
    would fire the abort criterion on any client that is not the mock at all."""
    url, control = stack
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
    assert (await _ask(control, "status"))["mock_version_mismatches"] == 0


async def test_a_stale_observer_counts_too(stack):
    """Every connection is checked, writer or not -- the log line always was, and a
    counter that disagreed with the warnings beside it would be read as a bug in one
    of them."""
    url, control = stack
    async with websockets.connect(f"{url}/?{REQUIRED}&_mv={expected_mock_version()}") as writer:
        await writer.recv()
        async with websockets.connect(f"{url}/?{REQUIRED}&role=observer&_mv={STALE}") as observer:
            await observer.recv()
            assert (await _ask(control, "status"))["mock_version_mismatches"] == 1
            # The snapshot stays scoped to the command-path holder: the observer's
            # stale version must not be attributed to the writer that is healthy.
            state = await _ask(control, "get_connection_state")
    assert state["observer_count"] == 1
    assert state["mock_version_match"] is True


async def test_a_stale_connection_is_never_refused(stack):
    """The decision on the ticket, executed. The bridge can see THAT the versions
    differ; it cannot see whether the difference matters, and rejecting would make
    every routine bump on either side an outage."""
    url, _ = stack
    async with websockets.connect(f"{url}/?{REQUIRED}&_mv={STALE}") as ws:
        assert json.loads(await ws.recv()) == {"type": p.MSG_CONNECTED, "device": "StubDevice"}
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(ws.recv(), timeout=0.2)
