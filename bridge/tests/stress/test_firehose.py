import os

import pytest

from tests.stress.firehose import (
    DEFAULT_PAYLOAD_BYTES,
    FIREHOSE_FILLER,
    FIREHOSE_HEADER_BYTES,
    decode_firehose_payload,
    encode_firehose_payload,
    run_firehose,
)


def test_payload_round_trips():
    buf = encode_firehose_payload(4242, 1234.5, DEFAULT_PAYLOAD_BYTES)
    assert len(buf) == DEFAULT_PAYLOAD_BYTES
    seq, t_inject = decode_firehose_payload(buf)
    assert seq == 4242
    assert t_inject == pytest.approx(1234.5)
    assert set(buf[FIREHOSE_HEADER_BYTES:]) == {FIREHOSE_FILLER}


def test_payload_matches_the_typescript_wire_format():
    """Same 12-byte header as tests/stress/firehose-transport.ts.

    seq as uint32 LE at offset 0, injection timestamp as float64 LE at offset 4.
    """
    buf = encode_firehose_payload(1, 0.0, FIREHOSE_HEADER_BYTES)
    assert buf[:4] == bytes([0x01, 0x00, 0x00, 0x00])
    assert len(buf) == FIREHOSE_HEADER_BYTES


def test_payload_smaller_than_the_header_is_refused():
    with pytest.raises(ValueError):
        encode_firehose_payload(0, 0.0, FIREHOSE_HEADER_BYTES - 1)


def test_decode_refuses_a_short_payload():
    with pytest.raises(ValueError):
        decode_firehose_payload(bytes(FIREHOSE_HEADER_BYTES - 1))


async def test_relay_loses_nothing_at_a_functional_rate():
    result = await run_firehose(rate_per_sec=450, duration_ms=2000)
    assert result.injected > 0
    assert result.lost == 0
    assert result.missing == 0
    assert result.out_of_order == 0
    assert result.saturated_ticks == 0


async def test_achieved_rate_is_measured_over_the_generation_window():
    """The generation window closes when emission stops, not after the drain.

    Including the drain in the denominator understates the achieved rate by
    drain/duration on EVERY row -- a uniform shortfall that reads exactly like
    host contention, and would void every row for the wrong reason. At this
    duration that bug costs 20%, so the tolerance below catches it.
    """
    result = await run_firehose(rate_per_sec=450, duration_ms=2000)
    assert result.saturated_ticks == 0
    assert result.achieved_rate_per_sec == pytest.approx(450, rel=0.1)


async def test_the_harness_can_actually_detect_loss():
    """Every functional assertion here is of the form "zero loss", and a harness
    that cannot detect loss at all passes every one of them.

    So break the subject deliberately: discard one in ten notifications in the
    CONSUMER and confirm the accounting notices. Execution proves the check ran;
    this proves the check works.
    """
    result = await run_firehose(rate_per_sec=450, duration_ms=2000, drop_every_nth=10)
    assert result.lost > 0
    assert result.missing > 0
    assert result.lost == pytest.approx(result.injected / 10, rel=0.3)


async def test_writes_travel_the_other_way_under_load():
    """The relay must still carry client->device traffic while saturated."""
    result = await run_firehose(rate_per_sec=450, duration_ms=1500, client_writes=25)
    assert result.writes_received == 25
    assert result.lost == 0


@pytest.mark.skipif(
    not os.environ.get("FIREHOSE_BASELINE"),
    reason="opt-in sustained rate ladder; saturates cores, announce before running",
)
@pytest.mark.parametrize("rate", [450, 900, 2250, 4500])
async def test_sustained_rate_ladder(rate):
    seconds = int(os.environ.get("FIREHOSE_SECONDS", "10"))
    result = await run_firehose(rate_per_sec=rate, duration_ms=seconds * 1000)
    print(f"\n{result.summary()}")
    assert result.lost == 0
    assert result.missing == 0
    # A non-zero count here means the generator hit its per-tick cap, so the row
    # measured the INSTRUMENT and says nothing about the relay.
    assert result.saturated_ticks == 0
