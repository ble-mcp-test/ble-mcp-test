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
    """The `RETRYABLE_CONNECT_ERRORS` array from src/constants.ts.

    It used to live inline in mock-bluetooth.ts as `const retryableErrors`. It
    moved to constants.ts when the list turned out to contain three strings this
    bridge has never emitted -- see test_every_retryable_substring_is_one_we_send.

    A hard failure rather than a skip when the file is gone: a silent skip would
    leave the wording unchecked while the test still reported green.
    """
    root = pathlib.Path(__file__).resolve().parents[2]
    source = root / "src" / "constants.ts"
    assert source.is_file(), (
        f"{source} is missing. It owns the client's retry-on-substring list, which "
        "this server's busy text must not collide with. If it has moved, point this "
        "check at its new home -- do not delete it."
    )
    text = source.read_text()
    # Anchor on the assignment, not the declaration: `readonly string[]` contains
    # a `]` that would truncate the slice to nothing and make every assertion
    # below vacuously true.
    start = text.index("RETRYABLE_CONNECT_ERRORS")
    start = text.index("= [", start)
    body = text[start : text.index("]", start)]
    # Strip `//` comments FIRST. An apostrophe in ordinary prose -- "the bridge's
    # own text" -- opens a spurious quote and the regex then returns a chunk of
    # comment as if it were a retry substring. Found exactly that way.
    body = re.sub(r"//[^\n]*", "", body)
    return re.findall(r"'([^']+)'", body)


def test_every_retryable_substring_is_one_we_send():
    """The mirror of the busy check, and it exists because the list had rotted.

    The busy test asks "does our refusal accidentally contain something the mock
    retries on". It cannot see the opposite failure: a mock retrying on text this
    bridge NEVER sends. That is what had happened -- `Bridge is disconnecting`,
    `Bridge is connecting` and `only ready state accepts connections` were all
    TypeScript-bridge-era wording, absent from this tree, so `maxConnectRetries`
    could never fire against the Python bridge.

    Its symptom is the ABSENCE of a retry, and nothing fails when a retry that
    would have succeeded never happens -- which is why it survived a replatform,
    a soak and a measured cut of the retry budget itself.

    So: every substring the client retries on must appear in some error THIS
    bridge can actually emit.
    """
    ours = [
        getattr(p, name)
        for name in dir(p)
        if name.endswith(("_ERROR", "_ERROR_PREFIX", "_ERROR_ADVICE"))
        and isinstance(getattr(p, name), str)
    ]
    assert ours, "found no error constants in protocol.py; the check would be vacuous"

    retryable = _mock_retryable_substrings()
    assert retryable, "found no retryable list; the check would be vacuous"

    orphans = [r for r in retryable if not any(r in sent for sent in ours)]
    assert orphans == [], (
        f"the mock retries on text this bridge never sends: {orphans}. "
        "Either the bridge reworded an error and the client was not updated, or "
        "the entry is dead. A retry condition nothing can satisfy is a waiter "
        "that cannot be woken."
    )


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


# --- force=true takeover ------------------------------------------------------


async def test_force_takes_over_and_warns_without_ending_the_handshake(relay):
    """The acceptance criterion for `warning`, over a real socket.

    The ORDER is the contract: warning, then connected. A client that treated the
    warning as terminal would fail the handshake here; one that ignored it would
    still connect. Interstitial means exactly this.
    """
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}&session=a") as first:
        await recv(first)
        async with websockets.connect(f"{url}/?{REQUIRED}&session=b&force=true") as second:
            warning = await recv(second)
            assert warning[p.FIELD_TYPE] == p.MSG_WARNING
            assert warning[p.FIELD_WARNING].startswith(p.TAKEOVER_WARNING_PREFIX)
            assert "a" in warning[p.FIELD_WARNING]
            assert (await recv(second))[p.FIELD_TYPE] == p.MSG_CONNECTED


async def test_the_evicted_owner_is_told_why_rather_than_just_dropped(relay):
    """A socket that stops is indistinguishable from a network fault. The whole
    incident turned on a run being contaminated with nothing saying so."""
    url, _ = relay
    first = await websockets.connect(f"{url}/?{REQUIRED}&session=a")
    await recv(first)
    second = await websockets.connect(f"{url}/?{REQUIRED}&session=b&force=true")
    frame = await recv(first)
    assert frame[p.FIELD_TYPE] == p.MSG_ERROR
    assert frame[p.FIELD_ERROR].startswith(p.EVICTED_ERROR_PREFIX)
    assert "b" in frame[p.FIELD_ERROR]
    with pytest.raises(websockets.exceptions.ConnectionClosed):
        await recv(first)
    await second.close()


async def test_the_takeover_warning_says_the_evicted_run_is_now_invalid(relay):
    """The warning exists to be acted on, not merely logged: whoever forced the
    takeover is the one who can say so wherever the other run is being watched."""
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}&session=a") as first:
        await recv(first)
        async with websockets.connect(f"{url}/?{REQUIRED}&session=b&force=true") as second:
            assert p.TAKEOVER_WARNING_ADVICE in (await recv(second))[p.FIELD_WARNING]


async def test_the_evicted_owners_transport_is_released_before_the_new_one_connects(relay):
    """Two transports must never hold the one radio, so the takeover waits."""
    url, transports = relay
    first = await websockets.connect(f"{url}/?{REQUIRED}&session=a")
    await recv(first)
    second = await websockets.connect(f"{url}/?{REQUIRED}&session=b&force=true")
    await recv(second)  # warning -- sent only after the displaced transport let go
    assert transports[0].is_connected() is False
    assert (await recv(second))[p.FIELD_TYPE] == p.MSG_CONNECTED
    assert transports[1].is_connected() is True
    await first.close()
    await second.close()


async def test_the_new_owner_really_owns_it(relay):
    url, transports = relay
    first = await websockets.connect(f"{url}/?{REQUIRED}&session=a")
    await recv(first)
    second = await websockets.connect(f"{url}/?{REQUIRED}&session=b&force=true")
    await recv(second)
    await recv(second)
    transports[1].inject(bytes([0x33]))
    assert p.data_payload(p.decode(await asyncio.wait_for(second.recv(), 2.0))) == bytes([0x33])
    await second.send(p.encode_data(bytes([0x44])))
    assert await eventually(lambda: transports[1].writes == [bytes([0x44])])
    await first.close()
    await second.close()


async def test_force_on_a_free_path_warns_about_nothing(relay):
    """A takeover notice that fires when nothing was taken is one nobody reads."""
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}&force=true") as ws:
        assert (await recv(ws))[p.FIELD_TYPE] == p.MSG_CONNECTED


async def test_a_non_true_force_value_is_falsy_and_still_rejected(relay):
    """bridge-server.ts:59 -- `=== 'true'`. force=1 is not a takeover."""
    url, _ = relay
    async with websockets.connect(f"{url}/?{REQUIRED}") as owner:
        await recv(owner)
        async with websockets.connect(f"{url}/?{REQUIRED}&force=1") as second:
            assert (await recv(second))[p.FIELD_ERROR].startswith(p.BUSY_ERROR_PREFIX)


async def test_an_observer_of_the_evicted_owner_is_ended_too(relay):
    """The stream it was watching no longer exists; a new owner's is a different
    stream from a different device link."""
    url, _ = relay
    first = await websockets.connect(f"{url}/?{REQUIRED}&session=a")
    await recv(first)
    watcher = await websockets.connect(f"{url}/?{OBSERVER}")
    await recv(watcher)
    second = await websockets.connect(f"{url}/?{REQUIRED}&session=b&force=true")
    assert (await recv(watcher))[p.FIELD_ERROR] == p.STREAM_ENDED_ERROR
    await first.close()
    await watcher.close()
    await second.close()


async def test_the_slot_is_reclaimable_after_a_takeover(relay):
    """The evicted connection's finally runs after the new owner claimed. If it
    freed the slot, this observer would be told nobody owns the path."""
    url, _ = relay
    first = await websockets.connect(f"{url}/?{REQUIRED}&session=a")
    await recv(first)
    second = await websockets.connect(f"{url}/?{REQUIRED}&session=b&force=true")
    await recv(second)
    await recv(second)
    await first.close()
    await asyncio.sleep(0.1)
    async with websockets.connect(f"{url}/?{OBSERVER}") as watcher:
        assert (await recv(watcher))[p.FIELD_TYPE] == p.MSG_CONNECTED
    await second.close()
