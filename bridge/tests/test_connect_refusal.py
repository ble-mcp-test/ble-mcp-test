"""A connect that fails must say why, not close with 1011.

`_refuse` states the rule in its own docstring -- "Say why, then close. Never
close silently" -- and every refusal in the ownership model honours it. The
transport-connect path did not: `TransportError` escaped `_relay` entirely, so
websockets closed the socket with 1011 (internal error) and the diagnosis was
lost between the log and the client.

Measured against real hardware on 2026-08-26 (TRA-1174), two bridges on one
ESP32 proxy, same MAC, four interleaved trials. The bridge composed exactly the
sentence the operator needed:

    device 6C:79:B8:26:03:A7 was not heard advertising to proxy
    192.168.50.170:6053 within 30s. A peripheral already held in another
    connection does not advertise, so this most often means it is in use rather
    than absent.

and then sent the client `1011 internal error`. The refusal was correct, the
holder was undisturbed, and the second operator could not tell any of that --
which is the "being refused is not enough" problem this ticket opens with,
occurring at the one moment it matters most.

`TransportError` is declared in `transport.py` rather than `esphome.py`
specifically so the relay can catch it. It was caught for writes and not for
connect.
"""

import asyncio
import json

import pytest
import websockets

from ble_bridge.config import Config
from ble_bridge.transport import DeviceInfo, TransportError
from ble_bridge.ws import protocol as p
from ble_bridge.ws.server import BridgeServer

REQUIRED = "service=180a&write=2a01&notify=2a02"

IN_USE = (
    "device 6C:79:B8:26:03:A7 was not heard advertising to proxy 10.0.0.1:6053 within 30s. "
    "A peripheral already held in another connection does not advertise, so this most often "
    "means it is in use rather than absent."
)


class RefusingTransport:
    """Fails the way a device held by another bridge actually fails."""

    def __init__(self, message: str) -> None:
        self._message = message

    def set_data_callback(self, _cb) -> None:  # noqa: ANN001 - test double
        pass

    async def connect(self) -> DeviceInfo:
        raise TransportError(self._message)

    async def write(self, _data: bytes) -> None:  # pragma: no cover - never reached
        raise AssertionError("connect failed; write must not be attempted")

    async def cleanup(self) -> None:
        pass


@pytest.fixture
async def refusing_relay():
    server = BridgeServer(
        Config(ws_host="127.0.0.1", ws_port=0), lambda _p: RefusingTransport(IN_USE)
    )
    port = await server.start()
    assert port != 8080
    try:
        yield f"ws://127.0.0.1:{port}"
    finally:
        await server.stop()


async def test_a_failed_connect_sends_the_reason_as_an_error_frame(refusing_relay):
    async with websockets.connect(f"{refusing_relay}/?{REQUIRED}&session=s") as ws:
        frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))

    assert frame[p.FIELD_TYPE] == p.MSG_ERROR
    # The whole diagnosis, not a summary of it. "in use rather than absent" is
    # the part that tells the operator to go and ask who has the reader instead
    # of going to look for the reader.
    assert frame[p.FIELD_ERROR] == IN_USE


async def test_the_socket_does_not_close_with_1011(refusing_relay):
    """1011 is 'the server hit a condition it has no message for'.

    Here it has an excellent message, so 1011 is a lie about the server's own
    state as well as being useless to the client.
    """
    ws = await websockets.connect(f"{refusing_relay}/?{REQUIRED}&session=s")
    try:
        await asyncio.wait_for(ws.recv(), timeout=10)
        with pytest.raises(websockets.ConnectionClosed) as caught:
            while True:
                await asyncio.wait_for(ws.recv(), timeout=10)
    finally:
        await ws.close()

    assert caught.value.rcvd is not None
    assert caught.value.rcvd.code != 1011
