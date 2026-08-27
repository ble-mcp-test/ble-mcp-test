"""A failed write used to vanish without a trace, at any log level.

`_receive_writer` called `transport.write(payload)`, which raises `TransportError`
on a dead BLE link. Nothing caught it, and `_whichever_finishes_first` then did
`asyncio.gather(..., return_exceptions=True)` and discarded the result. The client
saw a socket close; the log saw nothing; and the transport's own message -- the one
that names whether the PROXY was still reachable, which is the single genuinely
diagnostic distinction the two-state model exists to draw -- was collected into a
list and dropped.
"""

import asyncio
import json
from dataclasses import dataclass, field

import pytest
import websockets

from ble_bridge.config import Config
from ble_bridge.log_buffer import RX, TX
from ble_bridge.transport import DeviceInfo, TransportError
from ble_bridge.ws import protocol as p
from ble_bridge.ws.server import BridgeServer

REQUIRED = "service=180a&write=2a01&notify=2a02"

#: The shape of the real message, which is the part that has to survive to the log.
DEAD_LINK = (
    "esphome: refusing to write 2 bytes -- the BLE link to the device is down "
    "(the proxy is reachable)."
)


@dataclass
class FailingTransport:
    """Connects fine, then refuses every write. A device that dropped its link
    behind a proxy that is still perfectly happy."""

    error: Exception = field(default_factory=lambda: TransportError(DEAD_LINK))
    device: DeviceInfo = field(default_factory=lambda: DeviceInfo("StubDevice", "stub"))
    cleaned_up: bool = False
    _connected: bool = False
    _callback: object = None

    def set_data_callback(self, callback):
        self._callback = callback

    async def connect(self):
        self._connected = True
        return self.device

    async def write(self, data: bytes) -> None:
        raise self.error

    async def cleanup(self) -> None:
        self.cleaned_up = True
        self._connected = False

    def is_connected(self) -> bool:
        return self._connected

    def inject(self, payload: bytes) -> None:
        assert self._callback is not None
        self._callback(payload)


@pytest.fixture
async def failing_relay():
    transports: list[FailingTransport] = []

    def factory(_params):
        t = FailingTransport()
        transports.append(t)
        return t

    server = BridgeServer(Config(ws_host="127.0.0.1", ws_port=0, log_buffer_size=1000), factory)
    port = await server.start()
    try:
        yield f"ws://127.0.0.1:{port}", transports, server
    finally:
        await server.stop()


async def test_a_failed_write_is_logged(failing_relay, caplog):
    url, _, _ = failing_relay
    with caplog.at_level("ERROR", logger="ble_bridge"):
        async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
            await ws.recv()
            await ws.send(p.encode_data(b"\x01\x02"))
            await asyncio.wait_for(ws.recv(), 5.0)
    assert any(DEAD_LINK in r.getMessage() for r in caplog.records), (
        "the transport's own message did not reach the log"
    )


async def _next_error(ws):
    """The next `error` frame, skipping the `write_ack` that now precedes it.

    Since TRA-1153 item 5b a failed write is reported twice and in this order:
    `write_ack{ok: false}` names WHICH write failed, then the terminal `error`
    says the session is over. These tests are about the second. Skipping rather
    than reading one frame keeps them testing the sentence they were written for.
    """
    for _ in range(10):
        frame = json.loads(await asyncio.wait_for(ws.recv(), 5.0))
        if p.message_type(frame) != p.MSG_WRITE_ACK:
            return frame
    raise AssertionError("no error frame arrived")


async def test_the_transports_two_state_distinction_survives_to_the_client(failing_relay):
    """Reachable-proxy vs also-unreachable is the one thing that tells an operator
    whether to go and look at the reader or at the network."""
    url, _, _ = failing_relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        await ws.send(p.encode_data(b"\x01\x02"))
        frame = await _next_error(ws)
    assert p.message_type(frame) == p.MSG_ERROR
    assert "the proxy is reachable" in frame[p.FIELD_ERROR]


async def test_a_failed_write_releases_the_device(failing_relay):
    """Every subsequent write on this link fails too. Holding the reader open on a
    dead link is the state where the next client is refused for nothing."""
    url, transports, _ = failing_relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        await ws.send(p.encode_data(b"\x01\x02"))
        await asyncio.wait_for(ws.recv(), 5.0)
        for _ in range(200):
            if transports[0].cleaned_up:
                break
            await asyncio.sleep(0.01)
    assert transports[0].cleaned_up is True


async def test_an_unexpected_exception_is_also_reported_not_swallowed():
    """TransportError is the expected shape. Anything else out of bleak or
    aioesphomeapi went into the same gather and died just as quietly."""
    transports: list[FailingTransport] = []

    def factory(_params):
        t = FailingTransport(error=RuntimeError("something from three layers down"))
        transports.append(t)
        return t

    server = BridgeServer(Config(ws_host="127.0.0.1", ws_port=0), factory)
    port = await server.start()
    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/?{REQUIRED}") as ws:
            await ws.recv()
            await ws.send(p.encode_data(b"\x01\x02"))
            frame = await _next_error(ws)
        assert p.message_type(frame) == p.MSG_ERROR
        assert p.WRITE_FAILED_PREFIX in frame[p.FIELD_ERROR]
        assert "something from three layers down" in frame[p.FIELD_ERROR]
    finally:
        await server.stop()


# --- the packet record --------------------------------------------------------


@pytest.fixture
async def recording_relay():
    from ble_bridge.transport import StubTransport

    transports: list[StubTransport] = []

    def factory(_params):
        t = StubTransport()
        transports.append(t)
        return t

    server = BridgeServer(Config(ws_host="127.0.0.1", ws_port=0, log_buffer_size=1000), factory)
    port = await server.start()
    try:
        yield f"ws://127.0.0.1:{port}", transports, server
    finally:
        await server.stop()


async def test_relayed_traffic_is_recorded_in_both_directions(recording_relay):
    """What `search_packets` reads. Without it a wedge leaves nothing behind at
    all, and "the device sent nothing" is indistinguishable from "we stopped
    forwarding" -- two problems with opposite fixes."""
    url, transports, server = recording_relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        await ws.send(p.encode_data(bytes([0xA7, 0x01])))
        for _ in range(200):
            if transports[0].writes:
                break
            await asyncio.sleep(0.01)
        transports[0].inject(bytes([0xB3, 0x02]))
        await asyncio.wait_for(ws.recv(), 5.0)

    packets = [e for e in server.log_buffer.entries() if e.is_packet]
    assert (TX, "A7 01") in [(e.direction, e.text) for e in packets]
    assert (RX, "B3 02") in [(e.direction, e.text) for e in packets]


async def test_a_dropped_frame_is_not_recorded_as_relayed_traffic(recording_relay):
    """It never reached the device. Recording it as TX would put a packet in the
    log that the reader never saw, which is worse than no record."""
    url, _, server = recording_relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        await ws.send("not json at all")
        await asyncio.sleep(0.05)
    assert [e for e in server.log_buffer.entries() if e.direction == TX] == []


async def test_log_lines_and_packets_share_one_record_as_main_wires_them():
    """The interleaving only exists if `__main__` hands `configure()`'s buffer to
    the server, so this executes that wiring rather than trusting it.

    Two rings -- one for text, one for packets -- cannot answer the question a
    wedge post-mortem actually asks, which is what was on the wire at the moment
    the log went quiet.
    """
    import logging

    from ble_bridge.log_buffer import BufferHandler
    from ble_bridge.logging_setup import BRIDGE_LOGGER, configure
    from ble_bridge.transport import StubTransport

    bridge_logger = logging.getLogger(BRIDGE_LOGGER)
    root = logging.getLogger()
    saved = (root.level, list(root.handlers), list(bridge_logger.handlers))
    transports: list[StubTransport] = []

    def factory(_params):
        t = StubTransport()
        transports.append(t)
        return t

    config = Config(ws_host="127.0.0.1", ws_port=0, log_buffer_size=1000)
    try:
        buffer = configure(config)
        assert any(isinstance(h, BufferHandler) for h in bridge_logger.handlers)
        server = BridgeServer(config, factory, log_buffer=buffer)
        port = await server.start()
        try:
            async with websockets.connect(f"ws://127.0.0.1:{port}/?{REQUIRED}") as ws:
                await ws.recv()
                await ws.send(p.encode_data(bytes([0xA7])))
                for _ in range(200):
                    if transports[0].writes:
                        break
                    await asyncio.sleep(0.01)
        finally:
            await server.stop()
    finally:
        root.level, root.handlers, bridge_logger.handlers = saved[0], list(saved[1]), list(saved[2])

    entries = buffer.entries()
    assert any(e.direction == TX and e.text == "A7" for e in entries)
    assert any(not e.is_packet and "command path" in e.text for e in entries)
