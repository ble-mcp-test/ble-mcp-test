"""The single-writer slot, exercised with no sockets in the picture.

Ownership is the part of TRA-1159 most likely to be got wrong, and the ticket says
why: "restore the old single-client behaviour" is the natural reading, and it would
rebuild a guard keyed on session id -- which never covered the case that actually
happens, because both repos pin one session id per host. So the tests that matter
most here are the ones asserting a claim is refused even when the session ids match.
"""

import pytest

from ble_bridge.transport import DeviceInfo
from ble_bridge.ws import protocol as p
from ble_bridge.ws.ownership import (
    END_OF_STREAM,
    CommandPath,
    CommandPathBusy,
    CommandPathBusySelf,
    CommandPathNotReady,
    NothingToObserve,
)

DEVICE = DeviceInfo("CS108Reader", "aa:bb:cc:dd:ee:ff")


def test_an_empty_path_can_be_claimed():
    path = CommandPath()
    claim = path.claim("a", force=False)
    assert claim.session == "a"
    assert path.is_held


def test_a_second_claim_is_refused_and_names_the_holder():
    """ "Who has it" is the first thing an operator asks, and the 2026-08-23
    incident is what happens when nothing answers."""
    path = CommandPath()
    path.claim("a", force=False).ready(DEVICE)
    with pytest.raises(CommandPathBusy) as caught:
        path.claim("b", force=False)
    assert "a" in str(caught.value)


def test_a_second_claim_is_refused_even_under_the_same_session_id():
    """Per CONNECTION, not per session.

    A shared session id is the configured norm in this project -- ble-mcp-e2e-$host
    here, trakrf-handheld-dev-$host in platform -- so a guard keyed on it would
    never fire in the case that actually collides. This is that case.
    """
    path = CommandPath()
    path.claim("ble-mcp-e2e-knuckles", force=False).ready(DEVICE)
    with pytest.raises(CommandPathBusy):
        path.claim("ble-mcp-e2e-knuckles", force=False)


def test_a_claim_is_refused_while_the_holder_is_still_connecting():
    """The slot is taken from the first synchronous instant, before any await.

    Two writers arriving together must not both get past the guard while the first
    one's connect() is in flight.
    """
    path = CommandPath()
    path.claim("a", force=False)  # claimed, never made ready
    with pytest.raises(CommandPathBusy):
        path.claim("b", force=False)


# --- our own connection, still releasing --- TRA-1216 -------------------------
#
# The one case where "no amount of waiting changes that" is false. Measured on
# platform's 200-rep arm: 63 refusals, every holder released within 21ms, which is
# this bridge's own close-processing cost and nothing else.
#
# `closing` is the condition that carries the meaning -- waiting only helps when the
# holder is already on its way out. The session id merely adds "and it was mine".
# Keying on the id ALONE does not discriminate: both repos derive it from the
# hostname deliberately, for connection pool reuse, so two live platform processes
# on one host present the same name and the second would be handed a retry against
# a genuinely foreign holder.


def test_our_own_releasing_connection_is_a_distinguishable_refusal():
    path = CommandPath()
    holder = path.claim("trakrf-platform-dev-mssb", force=False)
    holder.ready(DEVICE)
    holder.closing = True
    with pytest.raises(CommandPathBusySelf) as caught:
        path.claim("trakrf-platform-dev-mssb", force=False)
    assert caught.value.code == p.ERR_DEVICE_BUSY_SELF


def test_a_LIVE_holder_under_the_same_session_id_is_still_the_loud_refusal():
    """GUARD: goes red the moment the `closing` condition is dropped.

    This is the case a session-id-only discriminator gets wrong, and it is the
    expensive one: a live foreign holder wearing our own name. `DEVICE_BUSY` exists
    to make exactly this loud, and a retry here would convert it into ~2.4s of
    pause followed by the same refusal.
    """
    path = CommandPath()
    path.claim("trakrf-platform-dev-mssb", force=False).ready(DEVICE)
    with pytest.raises(CommandPathBusy) as caught:
        path.claim("trakrf-platform-dev-mssb", force=False)
    assert not isinstance(caught.value, CommandPathBusySelf)
    assert caught.value.code == p.ERR_DEVICE_BUSY


def test_a_foreign_session_gets_the_loud_refusal_even_while_we_are_closing():
    """Closing is necessary, not sufficient. Somebody else's release is not our
    business to wait on -- the slot it frees is not promised to us."""
    path = CommandPath()
    holder = path.claim("some-other-host", force=False)
    holder.ready(DEVICE)
    holder.closing = True
    with pytest.raises(CommandPathBusy) as caught:
        path.claim("trakrf-platform-dev-mssb", force=False)
    assert not isinstance(caught.value, CommandPathBusySelf)


def test_two_unnamed_sessions_are_foreign_to_each_other():
    """GUARD: goes red the moment the non-empty `session` guard is dropped.

    Driven through claim() directly on purpose: params.py fills an absent session
    with a fresh uuid4 per connection, so no socket can reach this branch. That is
    exactly why it needs a test -- the protection is real but unreachable from the
    outside, so nothing else would notice it going away.

    Two anonymous clients are not the same client. An empty name is the ABSENCE of
    identity, and treating absence as a match is how a guard silently inverts.
    """
    path = CommandPath()
    holder = path.claim("", force=False)
    holder.ready(DEVICE)
    holder.closing = True
    with pytest.raises(CommandPathBusy) as caught:
        path.claim("", force=False)
    assert not isinstance(caught.value, CommandPathBusySelf)


def test_a_claim_is_not_closing_until_someone_says_so():
    """The flag defaults to the safe direction: unset means loud."""
    path = CommandPath()
    assert path.claim("a", force=False).closing is False


def test_force_evicts_the_holder_and_reports_whom():
    path = CommandPath()
    first = path.claim("a", force=False)
    first.ready(DEVICE)
    second = path.claim("b", force=True)
    assert second.evicted is first
    assert path.is_held


def test_force_is_refused_while_the_holder_is_still_connecting():
    """Tearing down a half-built device link is worse than saying "retry".

    The window is milliseconds and the message is distinguishable, so the caller
    learns something true rather than inheriting a link in an unknown state.
    """
    path = CommandPath()
    path.claim("a", force=False)
    with pytest.raises(CommandPathNotReady):
        path.claim("b", force=True)


def test_force_on_a_free_path_evicts_nothing():
    """A takeover notice that fires when nothing was taken is one nobody reads."""
    path = CommandPath()
    assert path.claim("a", force=True).evicted is None


def test_observing_an_empty_path_is_refused_rather_than_queued():
    """Waiting for an owner who may never arrive is failure class 1 by construction."""
    path = CommandPath()
    with pytest.raises(NothingToObserve):
        path.observe()


def test_observing_a_connecting_path_is_refused_distinguishably():
    """Distinct from NothingToObserve: this one is worth retrying, that one is not."""
    path = CommandPath()
    path.claim("a", force=False)
    with pytest.raises(CommandPathNotReady):
        path.observe()


def test_the_owner_is_a_subscriber_like_any_other():
    path = CommandPath()
    claim = path.claim("a", force=False)
    claim.ready(DEVICE)
    claim.fan_out(b"\x01")
    assert claim.own_subscription.queue.get_nowait() == b"\x01"


def test_a_notification_reaches_every_subscriber():
    path = CommandPath()
    claim = path.claim("a", force=False)
    claim.ready(DEVICE)
    one = path.observe()
    two = path.observe()
    claim.fan_out(b"\xa7")
    assert claim.own_subscription.queue.get_nowait() == b"\xa7"
    assert one.queue.get_nowait() == b"\xa7"
    assert two.queue.get_nowait() == b"\xa7"


def test_an_observer_sees_the_device_the_owner_connected_to():
    path = CommandPath()
    path.claim("a", force=False).ready(DEVICE)
    assert path.observe().device == DEVICE


def test_release_frees_the_slot_and_ends_every_stream():
    path = CommandPath()
    claim = path.claim("a", force=False)
    claim.ready(DEVICE)
    watcher = path.observe()
    ended = claim.release()
    assert path.is_held is False
    assert watcher in ended
    assert watcher.queue.get_nowait() is END_OF_STREAM


def test_a_released_claim_can_be_reclaimed():
    """A lock that never reopens would ship as a hang rather than as an error."""
    path = CommandPath()
    path.claim("a", force=False).release()
    assert path.claim("b", force=False).session == "b"


def test_releasing_twice_is_harmless():
    """The writer path releases in a finally that can run after an eviction."""
    path = CommandPath()
    claim = path.claim("a", force=False)
    claim.ready(DEVICE)
    claim.release()
    assert claim.release() == []


def test_a_stale_release_cannot_free_a_slot_somebody_else_now_holds():
    """The evicted owner's finally runs AFTER the new owner has claimed.

    If it cleared the slot it would silently un-own a live connection, and a third
    writer would then be admitted alongside it. Nothing would be slow; there would
    just be two writers on one reader, which is the whole hazard.
    """
    path = CommandPath()
    first = path.claim("a", force=False)
    first.ready(DEVICE)
    second = path.claim("b", force=True)
    first.release()
    assert path.is_held
    second.release()
    assert path.is_held is False


def test_an_evicted_claim_still_ends_its_own_observers():
    path = CommandPath()
    first = path.claim("a", force=False)
    first.ready(DEVICE)
    watcher = path.observe()
    path.claim("b", force=True)
    assert watcher in first.release()
    assert watcher.queue.get_nowait() is END_OF_STREAM


def test_fanning_out_after_release_reaches_nobody():
    """A stale transport delivering into a live subscriber's stream is 3f7eefb's
    bug class: events from a dead link processed as current."""
    path = CommandPath()
    claim = path.claim("a", force=False)
    claim.ready(DEVICE)
    watcher = path.observe()
    claim.release()
    watcher.queue.get_nowait()  # END_OF_STREAM
    claim.fan_out(b"\x02")
    assert watcher.queue.empty()


def test_an_observer_cannot_be_attached_to_a_released_path():
    path = CommandPath()
    path.claim("a", force=False).ready(DEVICE).release()
    with pytest.raises(NothingToObserve):
        path.observe()
