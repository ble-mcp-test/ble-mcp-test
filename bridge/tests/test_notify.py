"""The notify boundary: hand off, and never let a failure there be silent."""

from __future__ import annotations

import logging

import pytest

from ble_bridge.notify import FAILURE_LOG_INTERVAL, NotifySink


def test_a_notification_is_handed_straight_through():
    seen: list[bytes] = []
    sink = NotifySink(seen.append)

    sink(b"\xa7\xb3\x02")

    assert seen == [b"\xa7\xb3\x02"]
    assert sink.delivered == 1
    assert sink.failed == 0
    assert sink.healthy is True


def test_a_failing_handoff_does_not_propagate():
    """Matching aioesphomeapi: a broken consumer must not tear down the session.

    The point is not that raising is fine -- it is that the session survives it,
    so the reporting below is the ONLY way anyone finds out.
    """

    def explode(_payload: bytes) -> None:
        raise RuntimeError("relay is gone")

    sink = NotifySink(explode)
    sink(b"\x01\x02")  # must not raise

    assert sink.failed == 1
    assert sink.delivered == 0
    assert sink.healthy is False


def test_a_failing_handoff_is_reported_under_our_logger(caplog):
    """The whole reason this module exists.

    Left to aioesphomeapi this appears under `aioesphomeapi.connection` with
    nothing tying it to the bridge, and the bridge goes on reporting a healthy
    session while the client receives nothing.
    """

    def explode(_payload: bytes) -> None:
        raise RuntimeError("relay is gone")

    sink = NotifySink(explode, description="cs108 notify")
    with caplog.at_level(logging.ERROR, logger="ble_bridge.notify"):
        sink(b"1234")

    assert len(caplog.records) == 1
    record = caplog.records[0]
    assert record.name == "ble_bridge.notify"
    assert record.exc_info is not None, "the traceback must survive, not just a message"
    assert "LOST" in record.getMessage()
    assert "cs108 notify" in record.getMessage()


def test_a_storm_of_failures_does_not_bury_the_first_one(caplog):
    """At 45 msg/s an every-notification failure is 45 tracebacks a second."""

    def explode(_payload: bytes) -> None:
        raise RuntimeError("relay is gone")

    sink = NotifySink(explode)
    with caplog.at_level(logging.ERROR, logger="ble_bridge.notify"):
        for _ in range(FAILURE_LOG_INTERVAL * 2):
            sink(b"x")

    assert sink.failed == FAILURE_LOG_INTERVAL * 2
    # The first, plus one per interval -- not one per notification.
    assert len(caplog.records) == 3


def test_counts_distinguish_delivered_from_lost():
    outcomes = iter([None, RuntimeError("boom"), None])

    def sometimes(_payload: bytes) -> None:
        outcome = next(outcomes)
        if outcome is not None:
            raise outcome

    sink = NotifySink(sometimes)
    for _ in range(3):
        sink(b"x")

    assert (sink.delivered, sink.failed) == (2, 1)


def test_the_sink_is_not_a_coroutine():
    """An async sink would need scheduling, which is the unawaited-task shape."""
    sink = NotifySink(lambda _payload: None)
    assert sink(b"x") is None


@pytest.mark.parametrize("payload", [b"", b"\x00" * 244])
def test_empty_and_full_mtu_payloads_are_both_ordinary(payload):
    seen: list[bytes] = []
    NotifySink(seen.append)(payload)
    assert seen == [payload]
