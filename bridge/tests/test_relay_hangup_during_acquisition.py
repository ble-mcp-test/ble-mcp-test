"""A client that hangs up mid-acquisition must not keep holding the command path.

TRA-1189. `_write` claims the path, then `_relay` awaits `transport.connect()` --
and nothing watched the socket across that await. A client that gave up (its own
connect bound firing, or the browser going away) left the bridge acquiring a
device for a caller that no longer existed, holding the writer slot until the
acquisition finished on its own.

Measured on 2026-08-29, rep 95 of platform's soak: the client abandoned at
10003ms, the bridge completed the connection 12ms later and took the claim FOR
NOBODY, and the next three connection attempts inside 370ms were all refused
`Device is busy`. One slow connect became a whole-file cascade.

The socket close was authoritative everywhere else in this module -- four
`ConnectionClosed` handlers in the relay loops -- and unwatched at the one point
it cost something.
"""

import asyncio
import json

import pytest
import websockets

from ble_bridge.config import Config
from ble_bridge.transport import StubTransport
from ble_bridge.ws import protocol as p
from ble_bridge.ws.server import BridgeServer

REQUIRED = "service=180a&write=2a01&notify=2a02"
ACQUIRE_S = 2.0


class SlowTransport(StubTransport):
    """Acquisition long enough that a successor arrives while it is still running.

    Records cancellation rather than only lateness: "the successor got in" would
    also be satisfied by releasing the claim while the acquisition ran on in the
    background, which is a second claim on the radio wearing a released label.
    """

    cancelled: bool = False

    async def connect(self):
        try:
            await asyncio.sleep(ACQUIRE_S)
        except asyncio.CancelledError:
            object.__setattr__(self, "cancelled", True)
            raise
        return await super().connect()


@pytest.fixture
async def relay():
    transports: list[SlowTransport] = []

    def factory(_params):
        t = SlowTransport()
        transports.append(t)
        return t

    server = BridgeServer(Config(ws_host="127.0.0.1", ws_port=0), factory)
    port = await server.start()
    assert port != 8080
    try:
        yield f"ws://127.0.0.1:{port}", transports
    finally:
        await server.stop()


async def test_hangup_during_acquisition_frees_the_path_for_a_successor(relay):
    url, transports = relay

    abandoned = await websockets.connect(f"{url}/?{REQUIRED}&session=gone")
    await asyncio.sleep(0.2)  # inside the acquisition, well before it completes
    await abandoned.close()

    # The successor must be SERVED, not refused. Before the fix it arrives while
    # the abandoned claim is still held and is told `Device is busy` -- the exact
    # refusal rep 95 produced three of.
    async with websockets.connect(f"{url}/?{REQUIRED}&session=successor") as ws:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=ACQUIRE_S * 3))

    assert msg["type"] == p.MSG_CONNECTED, msg
    assert transports[0].cancelled is True, "the abandoned acquisition kept running"
