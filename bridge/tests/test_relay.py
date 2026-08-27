import asyncio
import json

import pytest
import websockets

from ble_bridge import write_mode
from ble_bridge.config import Config
from ble_bridge.mock_version import expected_mock_version
from ble_bridge.transport import StubTransport, TransportError
from ble_bridge.ws import protocol as p
from ble_bridge.ws.server import BridgeServer

REQUIRED = "service=180a&write=2a01&notify=2a02"


@pytest.fixture
async def relay():
    """An ephemeral loopback port.

    Never 8080: a real bridge may be running there, and a test that quietly
    attached to it would be measuring somebody else's process.
    """
    transports: list[StubTransport] = []

    def factory(_params):
        t = StubTransport()
        transports.append(t)
        return t

    server = BridgeServer(Config(ws_host="127.0.0.1", ws_port=0), factory)
    port = await server.start()
    assert port != 8080
    try:
        yield f"ws://127.0.0.1:{port}", transports
    finally:
        await server.stop()


async def test_connected_is_sent_on_a_valid_connection(relay):
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        assert json.loads(await ws.recv()) == {"type": "connected", "device": "StubDevice"}


async def test_notification_reaches_the_client_as_data(relay):
    url, transports = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        transports[0].inject(bytes([0xA7, 0x01, 0xFF]))
        assert p.data_payload(p.decode(await ws.recv())) == bytes([0xA7, 0x01, 0xFF])


async def test_client_data_is_written_to_the_transport(relay):
    url, transports = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        await ws.send(p.encode_data(bytes([0x02, 0x03])))
        for _ in range(200):
            if transports[0].writes:
                break
            await asyncio.sleep(0.01)
        assert transports[0].writes == [bytes([0x02, 0x03])]


async def test_notification_order_is_preserved(relay):
    """One queue, one sender. A task per notification would reorder these, and
    the firehose would report the reordering as loss."""
    url, transports = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        for i in range(200):
            transports[0].inject(bytes([i % 256]))
        got = [p.data_payload(p.decode(await ws.recv()))[0] for _ in range(200)]
        assert got == [i % 256 for i in range(200)]


async def test_an_empty_notification_still_arrives(relay):
    url, transports = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        transports[0].inject(b"")
        assert p.data_payload(p.decode(await ws.recv())) == b""


@pytest.mark.parametrize(
    "query",
    [
        "write=2a01&notify=2a02",
        "service=180a&notify=2a02",
        "service=180a&write=2a01",
        "",
    ],
)
async def test_missing_parameters_yield_the_documented_error_then_close(relay, query):
    url, _ = relay
    async with websockets.connect(f"{url}/?{query}") as ws:
        assert json.loads(await ws.recv()) == {
            "type": "error",
            "error": "Missing required parameters: service, write, notify",
        }
        with pytest.raises(websockets.exceptions.ConnectionClosed):
            await ws.recv()


async def test_no_transport_is_built_when_parameters_are_missing(relay):
    """A rejected connection must not claim the device on its way out."""
    url, transports = relay
    async with websockets.connect(f"{url}/?service=180a") as ws:
        await ws.recv()
    assert transports == []


async def test_an_undecodable_frame_does_not_kill_the_connection(relay):
    url, transports = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        await ws.send("not json at all")
        await ws.send(p.encode_data(bytes([0x09])))
        for _ in range(200):
            if transports[0].writes:
                break
            await asyncio.sleep(0.01)
        assert transports[0].writes == [bytes([0x09])]


async def test_transport_is_cleaned_up_when_the_client_goes_away(relay):
    url, transports = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
    for _ in range(200):
        if not transports[0].is_connected():
            break
        await asyncio.sleep(0.01)
    assert transports[0].is_connected() is False


async def test_absent_mv_only_warns_and_changes_nothing(relay, caplog):
    """_mv is telemetry: no message to the client, no rejection, no behaviour change."""
    url, _ = relay
    with caplog.at_level("WARNING"):
        async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
            assert json.loads(await ws.recv())["type"] == "connected"
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(ws.recv(), timeout=0.2)
    assert any("_mv" in r.message for r in caplog.records)


async def test_mismatched_mv_only_warns_and_changes_nothing(relay, caplog):
    url, _ = relay
    with caplog.at_level("WARNING"):
        async with websockets.connect(f"{url}/?{REQUIRED}&_mv=0.0.1-nope") as ws:
            assert json.loads(await ws.recv())["type"] == "connected"
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(ws.recv(), timeout=0.2)
    assert any("mismatch" in r.message.lower() for r in caplog.records)


async def test_matching_mv_produces_no_warning(relay, caplog):
    """A healthy mock must be silent.

    Comparing _mv against the wrong version number would warn on every
    correctly-behaving connection, and a warning that always fires is one
    nobody reads.
    """
    url, _ = relay
    with caplog.at_level("WARNING"):
        async with websockets.connect(f"{url}/?{REQUIRED}&_mv={expected_mock_version()}") as ws:
            assert json.loads(await ws.recv())["type"] == "connected"
    assert [r.message for r in caplog.records if "mismatch" in r.message.lower()] == []


async def test_a_daemon_with_no_clients_holds_no_transport(relay):
    """The lifecycle property: process lifetime is not a resource claim here."""
    _, transports = relay
    assert transports == []


# --- write_ack, TRA-1153 item 5b ----------------------------------------------


class FailingWriteTransport(StubTransport):
    """Connects, then refuses every write. The only way to reach the ok:false arm
    without a radio."""

    async def write(self, data: bytes) -> None:
        raise TransportError("the proxy is reachable but the device link is down")


async def _next_ack(ws):
    """The next write_ack, skipping anything that interleaves with it.

    A notification can arrive between a write and its acknowledgement, so reading
    exactly one frame would be a race that passes on a quiet stub and fails under
    load -- which is the flake that reads as a protocol defect.
    """
    for _ in range(20):
        msg = p.decode(await asyncio.wait_for(ws.recv(), timeout=2))
        if p.message_type(msg) == p.MSG_WRITE_ACK:
            return msg
    raise AssertionError("no write_ack arrived")


async def test_a_write_is_acknowledged(relay):
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        await ws.send(p.encode_data(bytes([0x02, 0x03])))
        ack = await _next_ack(ws)
        assert ack["ok"] is True
        assert "error" not in ack


async def test_the_ack_echoes_the_clients_write_id(relay):
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        await ws.send(json.dumps({"type": "data", "data": [1], "write_id": "w-42"}))
        assert (await _next_ack(ws))["write_id"] == "w-42"


async def test_a_write_with_no_write_id_is_still_acknowledged(relay):
    """The ack is a property of the protocol, not something a client opts into."""
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        await ws.send(p.encode_data(bytes([0x01])))
        assert "write_id" not in await _next_ack(ws)


async def test_acks_arrive_in_write_order(relay):
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        for i in range(5):
            await ws.send(json.dumps({"type": "data", "data": [i], "write_id": f"w-{i}"}))
        seen = [(await _next_ack(ws))["write_id"] for _ in range(5)]
        assert seen == [f"w-{i}" for i in range(5)]


async def test_a_frame_dropped_before_the_write_is_not_acknowledged(relay):
    """Why the ack carries the client's token rather than a position.

    An undecodable frame never reaches the device, so it gets no ack. Under
    positional correlation the next ack would be attributed to it silently, and
    every write after that would be off by one -- a wrong answer that looks like a
    right one. Spec section 8.
    """
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        await ws.send("not json at all")
        await ws.send(json.dumps({"type": "data", "data": [7], "write_id": "w-good"}))
        assert (await _next_ack(ws))["write_id"] == "w-good"


async def test_an_observer_gets_no_ack_for_a_refused_write(relay):
    """Nothing was attempted, so there is no outcome to report -- the observer gets
    the refusal it already had and no ack."""
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}&session=s1") as writer:
        await writer.recv()
        async with websockets.connect(f"{url}/?{REQUIRED}&session=s2&role=observer") as obs:
            await obs.recv()
            await obs.send(p.encode_data(bytes([0x01])))
            msg = p.decode(await asyncio.wait_for(obs.recv(), timeout=2))
            assert p.message_type(msg) == p.MSG_ERROR
            assert msg["error"] == p.OBSERVER_MAY_NOT_WRITE_ERROR


async def test_a_failed_write_is_acknowledged_then_the_session_ends():
    """ok:false is terminal today: the ack says WHICH write failed, and the error
    that follows says the session is over. Spec section 8."""
    server = BridgeServer(
        Config(ws_host="127.0.0.1", ws_port=0), lambda _params: FailingWriteTransport()
    )
    port = await server.start()
    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/?{REQUIRED}") as ws:
            await ws.recv()
            await ws.send(json.dumps({"type": "data", "data": [1], "write_id": "w-bad"}))
            ack = await _next_ack(ws)
            assert ack["ok"] is False
            assert ack["write_id"] == "w-bad"
            assert "device link is down" in ack["error"]
            final = p.decode(await asyncio.wait_for(ws.recv(), timeout=2))
            assert p.message_type(final) == p.MSG_ERROR
    finally:
        await server.stop()


async def test_the_ack_reports_the_mode_the_write_actually_used(relay):
    """Under write-without-response nothing comes back from the peer, so ok:true is
    a much weaker claim. The ack states which it is rather than leaving a reader to
    infer it from a runtime knob they cannot see."""
    url, _ = relay
    previous = write_mode.set_mode(False)
    try:
        async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
            await ws.recv()
            await ws.send(p.encode_data(bytes([0x01])))
            assert (await _next_ack(ws))["mode"] == "without-response"
    finally:
        write_mode.set_mode(previous)
