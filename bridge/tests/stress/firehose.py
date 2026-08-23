"""Drive the Python relay with synthetic notifications and measure it.

This is the Python counterpart of `tests/stress/firehose-transport.ts` and
`firehose-harness.ts`, and it exists for the same reason: the reader is a single
contended device, so the relay has to be characterisable while somebody else is
holding the radio -- or while no radio exists at all. Notifications are injected
at the transport seam, so there is no BLE radio, no ESPHome proxy, no protobuf
decode and no RF anywhere in the measured path.

THE COMPARISON CAVEAT, which matters more than any number below.

`docs/design/2026-08-23-firehose-baseline.md` records the TypeScript relay at
zero loss through 4500 msg/s, with p50 latency of 0.010-0.020 ms. Those figures
were taken with a Node injector and a Node consumer inside ONE process, sharing
one `performance.now()`; that shared clock is what made sub-millisecond latency
meaningful there. This harness injects in Python and consumes in Python, so both
the consumer and the clock arrangement differ.

The consequence is specific rather than general:

  * **Throughput and loss ARE comparable.** "Zero notifications lost at 4500/s"
    means the same thing in either language.
  * **Latency is NOT.** Swapping the consumer changes the number without changing
    the bridge, so quoting these microseconds against the TypeScript baseline
    would be comparing two different experiments.

So `summary()` reports rate and loss, and deliberately does not print a latency
comparison. A real cross-language latency comparison needs the SAME consumer
driven against both servers, which is a different experiment.
"""

from __future__ import annotations

import asyncio
import math
import struct
import time
from dataclasses import dataclass, field

import websockets

from ble_bridge.config import Config
from ble_bridge.transport import DataCallback, DeviceInfo
from ble_bridge.ws import protocol as p
from ble_bridge.ws.server import BridgeServer

#: seq (uint32 LE) + injection timestamp (float64 LE).
FIREHOSE_HEADER_BYTES = 12
#: Filler byte for the remainder of the payload.
FIREHOSE_FILLER = 0xA7
#: Roughly a CS108 status notification; overridable per run.
DEFAULT_PAYLOAD_BYTES = 20

_HEADER = struct.Struct("<Id")


def encode_firehose_payload(seq: int, t_inject_ms: float, payload_bytes: int) -> bytes:
    if payload_bytes < FIREHOSE_HEADER_BYTES:
        raise ValueError(f"payload_bytes must be >= {FIREHOSE_HEADER_BYTES}, got {payload_bytes}")
    buf = bytearray([FIREHOSE_FILLER]) * payload_bytes
    _HEADER.pack_into(buf, 0, seq, t_inject_ms)
    return bytes(buf)


def decode_firehose_payload(data: bytes) -> tuple[int, float]:
    if len(data) < FIREHOSE_HEADER_BYTES:
        raise ValueError(f"payload must be >= {FIREHOSE_HEADER_BYTES} bytes, got {len(data)}")
    seq, t_inject_ms = _HEADER.unpack_from(data, 0)
    return seq, t_inject_ms


def _now_ms() -> float:
    return time.perf_counter() * 1000.0


class FirehoseTransport:
    """A BleTransport that synthesises notifications instead of receiving them.

    Scheduling is absolute rather than incremental: each tick computes how many
    notifications SHOULD have been emitted by now and emits the difference, so a
    late timer does not permanently shift the rate. The per-tick cap stops a long
    stall being repaid as one enormous burst; ticks that hit the cap are counted,
    because a generator that cannot keep up is a shortfall in the INSTRUMENT and
    must never be reported as relay message loss.
    """

    def __init__(
        self,
        rate_per_sec: float,
        payload_bytes: int = DEFAULT_PAYLOAD_BYTES,
        tick_ms: float = 1.0,
        max_burst_multiple: int = 10,
    ) -> None:
        if rate_per_sec <= 0:
            raise ValueError(f"rate_per_sec must be > 0, got {rate_per_sec}")
        if payload_bytes < FIREHOSE_HEADER_BYTES:
            raise ValueError(f"payload_bytes must be >= {FIREHOSE_HEADER_BYTES}")

        self._rate = rate_per_sec
        self._payload_bytes = payload_bytes
        self._tick_s = tick_ms / 1000.0
        nominal_per_tick = math.ceil(rate_per_sec * tick_ms / 1000.0)
        self._max_burst = max(1, nominal_per_tick * max_burst_multiple)

        self._callback: DataCallback | None = None
        self._connected = False
        self._started_at = 0.0
        self._seq = 0
        self._saturated = 0
        self._task: asyncio.Task | None = None
        self.writes: list[bytes] = []

    @property
    def injected(self) -> int:
        """Notifications actually emitted so far."""
        return self._seq

    @property
    def saturated_ticks(self) -> int:
        """Ticks where the per-tick cap was hit: instrument shortfall, not loss."""
        return self._saturated

    def set_data_callback(self, callback: DataCallback) -> None:
        self._callback = callback

    async def connect(self) -> DeviceInfo:
        self._connected = True
        self._started_at = _now_ms()
        self._task = asyncio.create_task(self._generate())
        return DeviceInfo(name="FirehoseDevice", id="firehose")

    async def _generate(self) -> None:
        try:
            while self._connected:
                await asyncio.sleep(self._tick_s)
                if not self._connected or self._callback is None:
                    continue
                due = int((_now_ms() - self._started_at) * self._rate / 1000.0)
                budget = self._max_burst
                while self._seq < due and budget > 0:
                    self._callback(
                        encode_firehose_payload(self._seq, _now_ms(), self._payload_bytes)
                    )
                    self._seq += 1
                    budget -= 1
                if self._seq < due:
                    self._saturated += 1
        except asyncio.CancelledError:
            pass

    async def stop_emitting(self) -> None:
        """Stop generating without tearing down, so in-flight messages drain."""
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def write(self, data: bytes) -> None:
        self.writes.append(bytes(data))

    async def cleanup(self) -> None:
        await self.stop_emitting()
        self._connected = False

    def is_connected(self) -> bool:
        return self._connected


@dataclass
class FirehoseResult:
    target_rate_per_sec: float
    achieved_rate_per_sec: float
    duration_ms: float
    payload_bytes: int
    injected: int
    received: int
    #: injected - received. The headline "no message loss" figure.
    lost: int
    #: Sum of sequence-number gap sizes seen by the consumer.
    missing: int
    out_of_order: int
    saturated_ticks: int
    writes_received: int = 0
    dropped_by_consumer: int = 0
    notes: list[str] = field(default_factory=list)

    def summary(self) -> str:
        lines = [
            f"target {self.target_rate_per_sec:>6.0f} msg/s   "
            f"achieved {self.achieved_rate_per_sec:>7.1f} msg/s   "
            f"injected {self.injected:>7d}   received {self.received:>7d}",
            f"  lost {self.lost}   missing {self.missing}   "
            f"out-of-order {self.out_of_order}   saturated ticks {self.saturated_ticks}",
            "  latency omitted deliberately: a Python consumer is not comparable to the "
            "Node baseline (see module docstring)",
        ]
        return "\n".join(lines)


async def run_firehose(
    rate_per_sec: float,
    duration_ms: float,
    *,
    payload_bytes: int = DEFAULT_PAYLOAD_BYTES,
    drain_ms: float = 500.0,
    drop_every_nth: int | None = None,
    client_writes: int = 0,
) -> FirehoseResult:
    """Drive the relay at a target rate and account for every notification.

    Binds an OS-assigned ephemeral port on loopback. It must never touch 8080:
    a real bridge may be running there, and attaching to it would measure
    somebody else's process.

    `drop_every_nth` discards one in N notifications in the CONSUMER. It is a
    self-test only -- a harness that always reports zero loss is indistinguishable
    from one that cannot detect loss at all. Never set it for a real measurement.
    """
    transport = FirehoseTransport(rate_per_sec, payload_bytes=payload_bytes)
    server = BridgeServer(Config(ws_host="127.0.0.1", ws_port=0), lambda _params: transport)
    port = await server.start()
    if port == 8080:
        raise RuntimeError("refusing to measure on 8080: that is where a real bridge lives")

    received = 0
    dropped = 0
    missing = 0
    out_of_order = 0
    highest_seq = -1
    started = _now_ms()

    url = f"ws://127.0.0.1:{port}/?service=180a&write=2a01&notify=2a02&_mv=firehose"
    try:
        async with websockets.connect(url, max_queue=None) as ws:
            first = p.decode(await ws.recv())
            if p.message_type(first) != p.MSG_CONNECTED:
                raise RuntimeError(f"expected a connected frame, got {first!r}")

            for i in range(client_writes):
                await ws.send(p.encode_data(bytes([i % 256])))

            deadline = started + duration_ms
            while _now_ms() < deadline:
                remaining = (deadline - _now_ms()) / 1000.0
                if remaining <= 0:
                    break
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                except TimeoutError:
                    break
                seq, _ = decode_firehose_payload(p.data_payload(p.decode(raw)))

                if drop_every_nth and seq % drop_every_nth == 0:
                    dropped += 1
                    continue

                received += 1
                if seq > highest_seq + 1:
                    missing += seq - (highest_seq + 1)
                elif seq <= highest_seq:
                    out_of_order += 1
                highest_seq = max(highest_seq, seq)

            # Stop generating, then drain what is already in flight, so
            # in-flight notifications are not counted as loss.
            await transport.stop_emitting()
            injected = transport.injected
            # The generation window closes HERE. Measuring the achieved rate
            # against a span that also includes the drain would understate it by
            # drain_ms/duration_ms on every row -- a uniform shortfall that reads
            # exactly like host contention and would void every row for the wrong
            # reason.
            elapsed = _now_ms() - started
            drain_deadline = _now_ms() + drain_ms
            while _now_ms() < drain_deadline:
                remaining = (drain_deadline - _now_ms()) / 1000.0
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                except (TimeoutError, websockets.exceptions.ConnectionClosed):
                    break
                seq, _ = decode_firehose_payload(p.data_payload(p.decode(raw)))
                if drop_every_nth and seq % drop_every_nth == 0:
                    dropped += 1
                    continue
                received += 1
                if seq > highest_seq + 1:
                    missing += seq - (highest_seq + 1)
                elif seq <= highest_seq:
                    out_of_order += 1
                highest_seq = max(highest_seq, seq)

            writes_received = len(transport.writes)
    finally:
        await server.stop()

    return FirehoseResult(
        target_rate_per_sec=rate_per_sec,
        achieved_rate_per_sec=injected / (elapsed / 1000.0) if elapsed else 0.0,
        duration_ms=elapsed,
        payload_bytes=payload_bytes,
        injected=injected,
        received=received,
        # Consumer-side drops are deliberately counted as loss: that is the whole
        # point of the self-test, which must see them exactly as it would see a
        # relay that dropped them.
        lost=injected - received,
        missing=missing,
        out_of_order=out_of_order,
        saturated_ticks=transport.saturated_ticks,
        writes_received=writes_received,
        dropped_by_consumer=dropped,
    )
