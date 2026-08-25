"""A bounded in-memory record of everything this bridge saw.

## Why it exists

`get_logs` and `search_packets` are MCP tools that read a buffer, not a file.
TRA-1161 cannot deliver either of them without one, so it is built here rather
than twice.

The operational reason is older than that ticket. The TRA-1160 soak's cell B ran
781 times, hit two wedge episodes, and left a bridge log under 100 KB holding two
non-INFO lines. Whatever happened during those episodes is simply gone. A process
that keeps no record of the traffic it relayed cannot distinguish "the device sent
nothing" from "we stopped forwarding", and those two have opposite fixes.

## Shape

One ring, one sequence counter, packets and log lines interleaved. Interleaving is
the whole point: the question a post-mortem asks is "what was on the wire around
the moment it went quiet", and a separate packet log and text log cannot answer it
without a clock the two agree on.

`id` is global and monotonic, never a position in the ring. `since(cursor)` is the
read API, and reusing ids on wrap would hand a client entries it had already seen
while its cursor still looked sane.

Deliberately NOT restored from `log-buffer.ts`: its per-client position map and its
subscriber list. Both belong to the MCP surface that reads this, and TRA-1161 gets
to decide their shape against a real consumer rather than inheriting one.
"""

from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final

#: Traffic directions. Client -> device and device -> client, from the bridge's
#: point of view, matching the TX/RX spelling `log-buffer.ts` used so an operator
#: reading both eras' logs does not have to re-learn which way round they are.
TX: Final = "TX"
RX: Final = "RX"

#: Log-record levels, stored in the same field. `log-buffer.ts` did this too, and
#: it is what lets one ring hold both kinds of event in true order.
DEBUG: Final = "DEBUG"
INFO: Final = "INFO"
WARN: Final = "WARN"
ERROR: Final = "ERROR"

_LEVEL_NAMES: Final = {
    logging.DEBUG: DEBUG,
    logging.INFO: INFO,
    logging.WARNING: WARN,
    logging.ERROR: ERROR,
    logging.CRITICAL: ERROR,
}


@dataclass(frozen=True)
class LogEntry:
    """One packet or one log line.

    `text` carries the hex for a packet and the message for a log line. One field
    rather than two because a consumer that has to check which of two fields is
    populated will eventually check the wrong one.
    """

    id: int
    timestamp: str
    direction: str
    text: str
    size: int

    @property
    def is_packet(self) -> bool:
        return self.direction in (TX, RX)


class LogBuffer:
    """The last `maxsize` events, oldest evicted first.

    Not thread-safe, and it does not need to be: every writer reaches it from the
    bridge's event loop. The transport's notification callback is marshalled onto
    that loop by `loop.call_soon_threadsafe` before it touches anything here.
    """

    def __init__(self, maxsize: int) -> None:
        if maxsize < 0:
            raise ValueError(f"log buffer size {maxsize} is negative; 0 disables the buffer")
        self._maxsize = maxsize
        self._entries: deque[LogEntry] = deque(maxlen=maxsize or 1)
        self._next_id = 0
        self._packets_tx = 0
        self._packets_rx = 0

    @property
    def enabled(self) -> bool:
        """False when the operator set BLE_MCP_LOG_BUFFER_SIZE=0."""
        return self._maxsize > 0

    @property
    def maxsize(self) -> int:
        return self._maxsize

    @property
    def packets_tx(self) -> int:
        """Frames relayed client -> device since this process started."""
        return self._packets_tx

    @property
    def packets_rx(self) -> int:
        """Frames relayed device -> client since this process started."""
        return self._packets_rx

    @property
    def oldest_id(self) -> int | None:
        """The id of the oldest entry still held, or None when nothing is.

        With `next_id`, this is what lets a reader be told it fell behind the ring
        rather than being handed a short list that looks like a quiet device.
        """
        return self._entries[0].id if self._entries else None

    @property
    def next_id(self) -> int:
        """The id the next entry will take. `next_id - 1` is the newest held."""
        return self._next_id

    def push_packet(self, direction: str, payload: bytes) -> None:
        """Record one relayed frame. `direction` is TX or RX.

        The counters increment even when the ring is disabled. They are lifetime
        totals for this process, not a count of what is currently held: a
        connection-state report saying 0 packets because the operator set
        BLE_MCP_LOG_BUFFER_SIZE=0 would be a disabled buffer wearing a dead
        device's clothes.
        """
        if direction == TX:
            self._packets_tx += 1
        elif direction == RX:
            self._packets_rx += 1
        self._append(direction, _hex(payload), len(payload))

    def push_system(self, level: str, message: str) -> None:
        """Record one log line alongside the traffic that surrounded it."""
        self._append(level, message, 0)

    def entries(self) -> list[LogEntry]:
        return list(self._entries)

    def since(self, cursor: int | None, limit: int | None = None) -> list[LogEntry]:
        """Everything after `cursor`, oldest first. `None` means from the start.

        The cursor is an id, not an index. An entry the ring has already evicted is
        simply not returned; a caller that has fallen further behind than the ring
        is deep sees a gap, which is honest, where renumbering would hide it.
        """
        found = [e for e in self._entries if cursor is None or e.id > cursor]
        return found if limit is None else found[:limit]

    def system_since(self, cursor: int | None, limit: int | None = None) -> list[LogEntry]:
        """Log lines after `cursor`, packets excluded. TRA-1161's `get_logs` reads this."""
        found = [e for e in self.since(cursor) if not e.is_packet]
        return found if limit is None else found[:limit]

    def search_packets(self, hex_pattern: str, limit: int | None = None) -> list[LogEntry]:
        """Packets whose hex contains `hex_pattern`, oldest first.

        A substring match over the stored hex text, not a parse: frames are kept as
        hex strings, and a caller searching for "A7 B3" means those two bytes
        adjacent, wherever in the frame they land. Spacing and case in the pattern
        are irrelevant; a log line that happens to contain the same characters is
        not a frame and never matches.

        A pattern that is not hexadecimal raises rather than matching nothing.
        "zz" can never appear in a frame, so an empty result would read as "the
        device never sent that" -- a wrong answer that looks exactly like a right
        one, which is the failure mode this repo designs against.
        """
        needle = _normalise_hex_pattern(hex_pattern)
        found = [e for e in self._entries if e.is_packet and needle in _compact(e.text)]
        return found if limit is None else found[:limit]

    def _append(self, direction: str, text: str, size: int) -> None:
        if not self.enabled:
            return
        self._entries.append(
            LogEntry(
                id=self._next_id,
                timestamp=datetime.now(UTC).isoformat(),
                direction=direction,
                text=text,
                size=size,
            )
        )
        self._next_id += 1


def _hex(payload: bytes) -> str:
    """Uppercase, space separated -- the spelling `utils.ts:formatHex` produced,
    so a hex string copied out of an old log still matches one from this one."""
    return " ".join(f"{b:02X}" for b in payload)


def _compact(text: str) -> str:
    """The spacing-insensitive form both a stored frame and a search pattern reduce to."""
    return text.replace(" ", "").upper()


_HEXDIGITS: Final = frozenset("0123456789ABCDEF")


def _normalise_hex_pattern(pattern: str) -> str:
    """Uppercase, unspaced and hexadecimal -- or a refusal naming what was wrong."""
    compact = _compact(pattern)
    if not compact:
        raise ValueError("the hex pattern is empty, so there is nothing to search for")
    if not _HEXDIGITS.issuperset(compact):
        raise ValueError(
            f"the hex pattern {pattern!r} is not hexadecimal, so it can never match a "
            "frame. Refusing to return an empty result, which would read as 'the "
            "device never sent that'."
        )
    return compact


class BufferHandler(logging.Handler):
    """Feeds `logging` records into a LogBuffer.

    Attached to the `ble_bridge` logger by `logging_setup.configure`, so the level
    the operator asked for governs what gets kept here too. That is deliberate:
    a buffer that recorded DEBUG while the console showed INFO would make
    `BLE_MCP_LOG_LEVEL` mean two different things at once.
    """

    def __init__(self, buffer: LogBuffer) -> None:
        super().__init__()
        self._buffer = buffer

    def emit(self, record: logging.LogRecord) -> None:
        # Never raise out of a log handler: the caller is mid-diagnosis and an
        # exception here would replace the message it was trying to record.
        try:
            self._buffer.push_system(
                _LEVEL_NAMES.get(record.levelno, record.levelname),
                record.getMessage(),
            )
        except Exception:  # pragma: no cover - defensive, per logging's contract
            self.handleError(record)
