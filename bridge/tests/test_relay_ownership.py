"""Ownership over real sockets: who may write, who may only read, and what the
refused ones are told.

Separate from test_relay.py deliberately. That file asserts the relay works for one
client; this one asserts what happens to the second, which is a different subject
and the one TRA-1159 exists for.
"""

import asyncio
import json
import pathlib
import re

import pytest
import websockets

from ble_bridge.config import Config
from ble_bridge.transport import StubTransport
from ble_bridge.ws import protocol as p
from ble_bridge.ws.server import BridgeServer

REQUIRED = "service=180a&write=2a01&notify=2a02"
OBSERVER = f"{REQUIRED}&role=observer"


@pytest.fixture
async def relay():
    """An ephemeral loopback port.

    Never 8080: a real bridge may be running there, and a test that quietly attached
    to it would be measuring somebody else's process -- and, in this file
    particularly, would take the reader off whoever is using it.
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


async def recv(ws, timeout=2.0):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout=timeout))


async def eventually(predicate, timeout=2.0):
    """Poll until true. Used only where the thing being awaited is a teardown that
    has no message of its own -- never as a substitute for an assertion."""
    for _ in range(int(timeout / 0.01)):
        if predicate():
            return True
        await asyncio.sleep(0.01)
    return False


# --- the second writer --------------------------------------------------------


async def test_a_second_writer_is_rejected_loudly_and_then_closed(relay):
    """The whole ticket in one test: an error, not a timeout and not silence."""
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as owner:
        await recv(owner)
        async with websockets.connect(f"{url}/?{REQUIRED}") as second:
            frame = await recv(second)
            assert frame[p.FIELD_TYPE] == p.MSG_ERROR
            assert frame[p.FIELD_ERROR].startswith(p.BUSY_ERROR_PREFIX)
            with pytest.raises(websockets.exceptions.ConnectionClosed):
                await recv(second)


async def test_the_rejection_names_the_session_that_holds_the_path(relay):
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}&session=soak-runner") as owner:
        await recv(owner)
        async with websockets.connect(f"{url}/?{REQUIRED}&session=second-tab") as second:
            assert "soak-runner" in (await recv(second))[p.FIELD_ERROR]


async def test_the_rejection_tells_the_client_what_it_can_do_instead(relay):
    """A refusal with no route forward gets worked around, and the workaround is a
    second writer."""
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as owner:
        await recv(owner)
        async with websockets.connect(f"{url}/?{REQUIRED}") as second:
            text = (await recv(second))[p.FIELD_ERROR]
            assert "role=observer" in text
            assert "force=true" in text


async def test_the_rejected_writer_never_built_a_transport(relay):
    """A rejection must not claim the radio on its way out."""
    url, transports = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as owner:
        await recv(owner)
        async with websockets.connect(f"{url}/?{REQUIRED}") as second:
            await recv(second)
        assert len(transports) == 1


async def test_a_shared_session_id_does_not_widen_the_claim(relay):
    """This IS the common case, not an edge case.

    Both repos pin one session id per host, so the two colliding clients in the
    2026-08-23 incident would have presented exactly like this.
    """
    url, _ = relay
    shared = "ble-mcp-e2e-knuckles"
    async with websockets.connect(f"{url}/?{REQUIRED}&session={shared}") as owner:
        await recv(owner)
        async with websockets.connect(f"{url}/?{REQUIRED}&session={shared}") as second:
            assert (await recv(second))[p.FIELD_ERROR].startswith(p.BUSY_ERROR_PREFIX)


async def test_the_busy_error_is_not_one_the_mock_silently_retries():
    """The rejection must not be converted back into a wait by a string match.

    mock-bluetooth.ts:249-262 retries on three substrings, backing off to ten
    seconds and logging only. If the busy text contained one of them, the loud
    refusal this ticket exists to produce would present to the caller as a long
    pause and then some other failure -- failure class 1, reintroduced by wording.
    Checked mechanically because wording is exactly what drifts.
    """
    retryable = _mock_retryable_substrings()
    assert retryable, "found no retryable list in mock-bluetooth.ts; the check would be vacuous"
    hit = [r for r in retryable if r in p.BUSY_ERROR_PREFIX or r in p.BUSY_ERROR_ADVICE]
    assert hit == [], f"the busy error contains a substring the mock retries on: {hit}"


def _mock_retryable_substrings() -> list[str]:
    """The `retryableErrors` array from src/mock-bluetooth.ts.

    A hard failure rather than a skip when the file is gone: a silent skip here
    would leave the wording unchecked while the test still reported green.
    """
    root = pathlib.Path(__file__).resolve().parents[2]
    source = root / "src" / "mock-bluetooth.ts"
    assert source.is_file(), (
        f"{source} is missing. It owns the client's retry-on-substring list, which "
        "this server's busy text must not collide with. If the mock has moved, point "
        "this check at its new home -- do not delete it."
    )
    text = source.read_text()
    start = text.index("const retryableErrors")
    return re.findall(r"'([^']+)'", text[start : text.index("]", start)])


# --- the observer -------------------------------------------------------------


async def test_an_observer_reads_the_owners_stream(relay):
    url, transports = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as owner:
        await recv(owner)
        async with websockets.connect(f"{url}/?{OBSERVER}") as watcher:
            assert (await recv(watcher))[p.FIELD_TYPE] == p.MSG_CONNECTED
            transports[0].inject(bytes([0xA7]))
            assert p.data_payload(p.decode(await owner.recv())) == bytes([0xA7])
            assert p.data_payload(p.decode(await watcher.recv())) == bytes([0xA7])


async def test_an_observer_is_told_which_device_it_is_watching(relay):
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as owner:
        assert (await recv(owner))[p.FIELD_DEVICE] == "StubDevice"
        async with websockets.connect(f"{url}/?{OBSERVER}") as watcher:
            assert (await recv(watcher))[p.FIELD_DEVICE] == "StubDevice"


async def test_an_observer_gets_no_transport_of_its_own(relay):
    """Read-only by construction. A second transport would be a second claim on the
    radio wearing an observer's label."""
    url, transports = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as owner:
        await recv(owner)
        async with websockets.connect(f"{url}/?{OBSERVER}") as watcher:
            await recv(watcher)
            assert len(transports) == 1


async def test_two_observers_both_see_every_notification(relay):
    url, transports = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as owner:
        await recv(owner)
        async with websockets.connect(f"{url}/?{OBSERVER}") as one:
            await recv(one)
            async with websockets.connect(f"{url}/?{OBSERVER}") as two:
                await recv(two)
                transports[0].inject(bytes([0x42]))
                assert p.data_payload(p.decode(await one.recv())) == bytes([0x42])
                assert p.data_payload(p.decode(await two.recv())) == bytes([0x42])


async def test_an_observers_write_is_refused_and_never_reaches_the_device(relay):
    url, transports = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as owner:
        await recv(owner)
        async with websockets.connect(f"{url}/?{OBSERVER}") as watcher:
            await recv(watcher)
            await watcher.send(p.encode_data(bytes([0x99])))
            frame = await recv(watcher)
            assert frame[p.FIELD_TYPE] == p.MSG_ERROR
            assert frame[p.FIELD_ERROR] == p.OBSERVER_MAY_NOT_WRITE_ERROR
    assert transports[0].writes == []


async def test_a_refused_write_does_not_end_the_observers_stream(relay):
    """Read-only, not disconnect-on-mistake. The debugging session survives its own
    typo, which is the difference between a usable role and a trap."""
    url, transports = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as owner:
        await recv(owner)
        async with websockets.connect(f"{url}/?{OBSERVER}") as watcher:
            await recv(watcher)
            await watcher.send(p.encode_data(bytes([0x99])))
            await recv(watcher)
            transports[0].inject(bytes([0x11]))
            assert p.data_payload(p.decode(await watcher.recv())) == bytes([0x11])


async def test_the_owner_can_still_write_while_observed(relay):
    url, transports = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as owner:
        await recv(owner)
        async with websockets.connect(f"{url}/?{OBSERVER}") as watcher:
            await recv(watcher)
            await owner.send(p.encode_data(bytes([0x07])))
            assert await eventually(lambda: transports[0].writes == [bytes([0x07])])


async def test_observing_with_no_owner_is_refused_rather_than_hanging(relay):
    """Attaching to a stream that does not exist must not become a silent wait for
    one that may never start."""
    url, transports = relay
    async with websockets.connect(f"{url}/?{OBSERVER}") as watcher:
        frame = await recv(watcher)
        assert frame[p.FIELD_TYPE] == p.MSG_ERROR
        assert frame[p.FIELD_ERROR] == p.NOTHING_TO_OBSERVE_ERROR
        with pytest.raises(websockets.exceptions.ConnectionClosed):
            await recv(watcher)
    assert transports == []


async def test_the_observer_is_told_when_the_owner_leaves(relay):
    """The stream ends with a sentence, not with a socket that simply stops."""
    url, _ = relay
    owner = await websockets.connect(f"{url}/?{REQUIRED}")
    await recv(owner)
    watcher = await websockets.connect(f"{url}/?{OBSERVER}")
    await recv(watcher)
    await owner.close()
    frame = await recv(watcher)
    assert frame[p.FIELD_TYPE] == p.MSG_ERROR
    assert frame[p.FIELD_ERROR] == p.STREAM_ENDED_ERROR
    with pytest.raises(websockets.exceptions.ConnectionClosed):
        await recv(watcher)
    await watcher.close()


async def test_an_observer_leaving_does_not_disturb_the_owner(relay):
    url, transports = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as owner:
        await recv(owner)
        watcher = await websockets.connect(f"{url}/?{OBSERVER}")
        await recv(watcher)
        await watcher.close()
        await asyncio.sleep(0.05)
        transports[0].inject(bytes([0x55]))
        assert p.data_payload(p.decode(await owner.recv())) == bytes([0x55])


# --- the slot reopens ---------------------------------------------------------


async def test_the_slot_is_free_again_once_the_owner_goes(relay):
    """A lock that never reopens would ship as a hang rather than as an error."""
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as first:
        await recv(first)
    async with websockets.connect(f"{url}/?{REQUIRED}") as second:
        assert (await recv(second))[p.FIELD_TYPE] == p.MSG_CONNECTED


async def test_a_rejected_writer_does_not_consume_the_slot_on_its_way_out(relay):
    """The rejection path must not release a claim it never made."""
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as owner:
        await recv(owner)
        async with websockets.connect(f"{url}/?{REQUIRED}") as second:
            await recv(second)
        async with websockets.connect(f"{url}/?{OBSERVER}") as watcher:
            assert (await recv(watcher))[p.FIELD_TYPE] == p.MSG_CONNECTED


async def test_the_owners_transport_is_released_when_it_leaves(relay):
    url, transports = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as owner:
        await recv(owner)
    assert await eventually(lambda: not transports[0].is_connected())
