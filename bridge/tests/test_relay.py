import asyncio
import json

import pytest
import websockets

from ble_bridge.config import Config
from ble_bridge.mock_version import expected_mock_version
from ble_bridge.transport import StubTransport
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


async def test_two_clients_get_independent_transports(relay):
    """Ownership between them is TRA-1159; this only pins that each gets its own."""
    url, transports = relay
    async with websockets.connect(f"{url}/?{REQUIRED}&session=a") as one:
        await one.recv()
        async with websockets.connect(f"{url}/?{REQUIRED}&session=b") as two:
            await two.recv()
            transports[0].inject(bytes([0x11]))
            transports[1].inject(bytes([0x22]))
            assert p.data_payload(p.decode(await one.recv())) == bytes([0x11])
            assert p.data_payload(p.decode(await two.recv())) == bytes([0x22])


async def test_a_daemon_with_no_clients_holds_no_transport(relay):
    """The lifecycle property: process lifetime is not a resource claim here."""
    _, transports = relay
    assert transports == []
