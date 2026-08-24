"""The idle timeout, measured where it is actually stamped.

test_idle.py covers the clock. This covers the part that gets got wrong: which
events are allowed to touch it. Every test here states the rule it is pinning,
because "outbound renews the lease" is a one-character change that no test would
otherwise notice -- it makes an abandoned session immortal, and an immortal
session is not slow and does not report an error.
"""

import asyncio
import contextlib
import json

import pytest
import websockets

from ble_bridge.config import Config
from ble_bridge.transport import StubTransport
from ble_bridge.ws import protocol as p
from ble_bridge.ws.server import BridgeServer

REQUIRED = "service=180a&write=2a01&notify=2a02"

#: Short enough that a test finishes, long enough that a loaded CI box does not
#: trip it between two awaits in the same coroutine.
IDLE = 0.4


@pytest.fixture
async def idle_relay():
    """A relay whose writers are released after IDLE seconds with nothing inbound."""
    transports: list[StubTransport] = []

    def factory(_params):
        t = StubTransport()
        transports.append(t)
        return t

    server = BridgeServer(
        Config(ws_host="127.0.0.1", ws_port=0, idle_timeout=IDLE, log_buffer_size=1000),
        factory,
    )
    port = await server.start()
    assert port != 8080
    try:
        yield f"ws://127.0.0.1:{port}", transports, server
    finally:
        await server.stop()


async def _next_frame(ws, timeout=IDLE * 8):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


async def test_an_idle_writer_is_told_why_before_it_is_dropped(idle_relay):
    """A silent release is indistinguishable from a wedge to whoever comes back to
    the desk, which is the state this ticket exists to end."""
    url, _, _ = idle_relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        frame = await _next_frame(ws)
    assert p.message_type(frame) == p.MSG_ERROR
    assert p.IDLE_TIMEOUT_ERROR_PREFIX in frame[p.FIELD_ERROR]


async def test_an_idle_writer_releases_the_device(idle_relay):
    """The point of the timeout. `cleanup()` is what frees the reader for the next
    consumer; an error frame with the transport still held would be theatre."""
    url, transports, _ = idle_relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        await _next_frame(ws)
        for _ in range(200):
            if not transports[0].is_connected():
                break
            await asyncio.sleep(0.01)
    assert transports[0].is_connected() is False


async def test_an_idle_writer_releases_the_command_path(idle_relay):
    """Releasing the radio but not the slot would leave the bridge refusing every
    subsequent writer on behalf of a connection that no longer exists."""
    url, _, server = idle_relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        await _next_frame(ws)
        for _ in range(200):
            if not server.command_path.is_held:
                break
            await asyncio.sleep(0.01)
    assert server.command_path.is_held is False


async def test_the_release_is_logged(idle_relay, caplog):
    """`say so -- in the log and to the client`. Both, not either."""
    url, _, _ = idle_relay
    with caplog.at_level("WARNING", logger="ble_bridge"):
        async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
            await ws.recv()
            await _next_frame(ws)
    assert any("idle" in r.getMessage().lower() for r in caplog.records)


async def test_inbound_frames_renew_the_lease(idle_relay):
    """The one thing that is allowed to keep a session alive."""
    url, transports, _ = idle_relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        for _ in range(6):
            await asyncio.sleep(IDLE / 3)
            await ws.send(p.encode_data(b"\x01"))
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(ws.recv(), IDLE / 3)
        assert transports[0].is_connected() is True


async def test_outbound_notifications_do_NOT_renew_the_lease(idle_relay):
    """The rule this whole module exists for.

    A stream of device -> client notifications must not look like activity. Count
    them and an abandoned session renews its own lease forever: the reader emits
    unprompted traffic on its own -- timed battery state, heartbeats, and during
    inventory a continuous tag stream -- so the lease would never lapse, the
    device would never be released, and the timeout would look configured and
    working the entire time.

    Note what this test asserts against the ticket's acceptance summary, which
    reads "a session streaming inventory with no inbound frames is NOT [released]".
    Ticket body section 2 is explicit and argued at length in the other direction
    -- "Outbound must never count", "Stamp the clock inside that `if`, and only
    there" -- and the mitigation it gives for a long LOCATE hold is choosing a
    floor that clears it, not counting outbound. The body is the decision.
    """
    url, transports, _ = idle_relay

    async def keep_streaming():
        while True:
            with contextlib.suppress(RuntimeError):
                transports[0].inject(b"\xa7\x01")
            await asyncio.sleep(IDLE / 10)

    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        streaming = asyncio.create_task(keep_streaming())
        try:
            errors = []
            deadline = asyncio.get_running_loop().time() + IDLE * 8
            while asyncio.get_running_loop().time() < deadline:
                frame = json.loads(await asyncio.wait_for(ws.recv(), IDLE * 8))
                if p.message_type(frame) == p.MSG_ERROR:
                    errors.append(frame)
                    break
        finally:
            streaming.cancel()
            await asyncio.gather(streaming, return_exceptions=True)

    assert errors, "an outbound-only session was never released: outbound renewed the lease"
    assert p.IDLE_TIMEOUT_ERROR_PREFIX in errors[0][p.FIELD_ERROR]


async def _sending_until_cancelled(ws, frame: str):
    """Keep a client talking in the background.

    A background task, not an inline loop: the release closes the socket, and a
    foreground sender would then raise ConnectionClosed on its own next send
    before the test ever got to read the error frame -- a passing assertion
    replaced by an unrelated exception.
    """
    with contextlib.suppress(websockets.exceptions.ConnectionClosed):
        while True:
            await asyncio.sleep(IDLE / 3)
            await ws.send(frame)


async def test_a_malformed_frame_does_not_renew_the_lease(idle_relay):
    """`_payload_or_none` drops these, so they never reached the device. A frame
    the relay refused to act on must not count as the client being alive."""
    url, _, _ = idle_relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as ws:
        await ws.recv()
        sending = asyncio.create_task(_sending_until_cancelled(ws, "not json at all"))
        try:
            frame = await _next_frame(ws)
        finally:
            sending.cancel()
            await asyncio.gather(sending, return_exceptions=True)
    assert p.message_type(frame) == p.MSG_ERROR
    assert p.IDLE_TIMEOUT_ERROR_PREFIX in frame[p.FIELD_ERROR]


async def test_an_observer_cannot_renew_the_writers_lease(idle_relay):
    """`Attached observers must not extend the lease.`

    An observer sends nothing by construction, and its writes are refused rather
    than relayed -- but "by construction" is a claim that has to be executed to
    be worth anything.
    """
    url, _, _ = idle_relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as writer:
        await writer.recv()
        async with websockets.connect(f"{url}/?{REQUIRED}&role=observer") as observer:
            await observer.recv()
            sending = asyncio.create_task(
                _sending_until_cancelled(observer, p.encode_data(b"\x01"))
            )
            try:
                frame = await _next_frame(writer)
            finally:
                sending.cancel()
                await asyncio.gather(sending, return_exceptions=True)
    assert p.message_type(frame) == p.MSG_ERROR
    assert p.IDLE_TIMEOUT_ERROR_PREFIX in frame[p.FIELD_ERROR]


async def test_the_timeout_can_be_turned_off():
    """0 is the operator's choice, and it must be the absence of a timer rather
    than a timer that fires at once."""
    transports: list[StubTransport] = []
    server = BridgeServer(
        Config(ws_host="127.0.0.1", ws_port=0, idle_timeout=0),
        lambda _p: transports.append(t := StubTransport()) or t,
    )
    port = await server.start()
    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}/?{REQUIRED}") as ws:
            await ws.recv()
            await asyncio.sleep(IDLE * 3)
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(ws.recv(), IDLE)
            assert transports[0].is_connected() is True
    finally:
        await server.stop()
