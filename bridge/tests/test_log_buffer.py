"""The in-memory record TRA-1161's `get_logs` and `search_packets` will read.

The soak's central blind spot was not only that the level was wrong. Cell B's
whole 781-run bridge log holds two non-INFO lines, and there was no packet record
at all -- so a wedge episode leaves nothing behind to look at afterwards, which is
the state in which "the bridge said nothing" and "nothing happened" are the same
observation.

`log-buffer.ts` is the capability being restored, not the implementation. The
shape that matters to the two MCP tools is: a monotonic id, a timestamp, a
direction, and a bounded ring.
"""

import logging

import pytest

from ble_bridge.log_buffer import DEBUG, ERROR, INFO, RX, TX, BufferHandler, LogBuffer


def test_a_packet_is_recorded_in_both_directions():
    buf = LogBuffer(100)
    buf.push_packet(TX, bytes([0xA7, 0x01]))
    buf.push_packet(RX, bytes([0xB3]))
    assert [(e.direction, e.text) for e in buf.entries()] == [
        (TX, "A7 01"),
        (RX, "B3"),
    ]


def test_sizes_are_recorded_so_search_packets_can_filter_on_them():
    buf = LogBuffer(100)
    buf.push_packet(TX, bytes(5))
    assert buf.entries()[0].size == 5


def test_an_empty_packet_is_still_an_entry():
    """An empty notification is a real event on this relay -- test_relay covers the
    wire side. A record that drops it would misreport the gap as silence."""
    buf = LogBuffer(100)
    buf.push_packet(RX, b"")
    assert buf.entries()[0].size == 0
    assert buf.entries()[0].text == ""


def test_ids_are_monotonic_and_survive_eviction():
    """`since` is a cursor, so ids must not be re-used when the ring wraps.

    Numbering by position instead would make a client that asks for "everything
    after 3" receive entries it has already seen, silently.
    """
    buf = LogBuffer(100)
    for i in range(150):
        buf.push_packet(TX, bytes([i % 256]))
    ids = [e.id for e in buf.entries()]
    assert ids == list(range(50, 150))


def test_the_ring_is_bounded():
    buf = LogBuffer(10)
    for i in range(100):
        buf.push_packet(TX, bytes([i % 256]))
    assert len(buf.entries()) == 10


def test_since_returns_only_what_follows_the_cursor():
    buf = LogBuffer(100)
    for i in range(5):
        buf.push_packet(TX, bytes([i]))
    assert [e.id for e in buf.since(2)] == [3, 4]


def test_since_none_returns_everything():
    buf = LogBuffer(100)
    buf.push_packet(TX, b"\x01")
    assert len(buf.since(None)) == 1


def test_since_respects_a_limit():
    buf = LogBuffer(100)
    for i in range(10):
        buf.push_packet(TX, bytes([i]))
    assert [e.id for e in buf.since(None, limit=3)] == [0, 1, 2]


def test_a_disabled_buffer_records_nothing_and_does_not_raise():
    """0 is the operator turning it off, not a misconfiguration to work around."""
    buf = LogBuffer(0)
    buf.push_packet(TX, b"\x01")
    buf.push_system(INFO, "hello")
    assert buf.entries() == []
    assert buf.enabled is False


# --- the logging handler ------------------------------------------------------


def test_log_records_land_in_the_buffer(caplog):
    buf = LogBuffer(100)
    logger = logging.getLogger("test_log_buffer.handler")
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    handler = BufferHandler(buf)
    logger.addHandler(handler)
    try:
        logger.info("the device link went down")
        logger.error("and stayed down")
    finally:
        logger.removeHandler(handler)

    assert [(e.direction, e.text) for e in buf.entries()] == [
        (INFO, "the device link went down"),
        (ERROR, "and stayed down"),
    ]


def test_the_handler_records_the_level_it_was_given():
    buf = LogBuffer(100)
    logger = logging.getLogger("test_log_buffer.levels")
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    handler = BufferHandler(buf)
    logger.addHandler(handler)
    try:
        logger.debug("a mid-session link drop, invisible at INFO")
    finally:
        logger.removeHandler(handler)
    assert buf.entries()[0].direction == DEBUG


def test_packets_and_log_lines_share_one_ordered_record():
    """The question a wedge post-mortem asks is "what happened around run 308",
    and interleaving is the only thing that answers it."""
    buf = LogBuffer(100)
    buf.push_packet(TX, b"\xa7")
    buf.push_system(ERROR, "write failed")
    buf.push_packet(RX, b"\xb3")
    assert [e.direction for e in buf.entries()] == [TX, ERROR, RX]
    assert [e.id for e in buf.entries()] == [0, 1, 2]


@pytest.mark.parametrize("size", [-1])
def test_a_negative_size_is_refused(size):
    with pytest.raises(ValueError):
        LogBuffer(size)


# --- the reads TRA-1161's tools make -----------------------------------------


def test_search_packets_matches_a_hex_substring_ignoring_spaces_and_case():
    buf = LogBuffer(100)
    buf.push_packet(TX, bytes([0xA7, 0xB3, 0x02]))
    buf.push_packet(RX, bytes([0x01]))
    assert [e.text for e in buf.search_packets("a7b3")] == ["A7 B3 02"]
    assert [e.text for e in buf.search_packets("A7 B3")] == ["A7 B3 02"]


def test_search_packets_never_matches_a_log_line():
    """A log line reading 'A7B3 timed out' is prose, not a frame."""
    buf = LogBuffer(100)
    buf.push_system(ERROR, "A7B3 timed out")
    assert buf.search_packets("a7b3") == []


def test_search_packets_respects_a_limit():
    buf = LogBuffer(100)
    for _ in range(5):
        buf.push_packet(TX, bytes([0xA7]))
    assert len(buf.search_packets("a7", limit=2)) == 2


def test_search_packets_refuses_a_non_hex_pattern():
    """'zz' can never match, so [] would read as 'the device never sent it'."""
    buf = LogBuffer(100)
    with pytest.raises(ValueError):
        buf.search_packets("zz")


def test_search_packets_refuses_an_empty_pattern():
    buf = LogBuffer(100)
    with pytest.raises(ValueError):
        buf.search_packets("  ")


def test_system_since_returns_only_log_lines_after_the_cursor():
    buf = LogBuffer(100)
    buf.push_system(INFO, "one")
    buf.push_packet(TX, b"\xa7")
    buf.push_system(ERROR, "two")
    assert [e.text for e in buf.system_since(None)] == ["one", "two"]
    assert [e.text for e in buf.system_since(1)] == ["two"]


def test_lifetime_packet_counters_survive_eviction():
    buf = LogBuffer(10)
    for _ in range(30):
        buf.push_packet(TX, b"\x01")
    for _ in range(20):
        buf.push_packet(RX, b"\x02")
    assert (buf.packets_tx, buf.packets_rx) == (30, 20)
    assert len(buf.entries()) == 10


def test_packet_counters_still_count_while_the_buffer_is_disabled():
    """get_connection_state must not report 0 packets on a bridge relaying traffic
    just because the operator turned the ring off."""
    buf = LogBuffer(0)
    buf.push_packet(TX, b"\x01")
    buf.push_packet(RX, b"\x02")
    assert (buf.packets_tx, buf.packets_rx) == (1, 1)


def test_oldest_id_and_next_id_expose_the_gap_a_late_reader_would_see():
    buf = LogBuffer(10)
    for i in range(30):
        buf.push_packet(TX, bytes([i % 256]))
    assert buf.oldest_id == 20
    assert buf.next_id == 30


def test_an_empty_buffer_has_no_oldest_id():
    assert LogBuffer(10).oldest_id is None
