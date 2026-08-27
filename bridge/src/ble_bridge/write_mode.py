"""The GATT write path's response mode, as a runtime knob rather than config.

Two facts force this to be mutable at runtime instead of a field on the frozen
`Config`:

1. TRA-1153 item 5 has to measure write-with-response against write-without-
   response under a dense tag field. Arms run in a fixed order are a correlation
   with time wearing a control's clothes -- platform made exactly that mistake on
   TRA-1179 and had to dissolve a "confirmed regression" that was really run
   order. So the arms must INTERLEAVE, which means the arm changes between runs
   without restarting the bridge.

2. A restart-per-arm would hold the arm constant only by varying bridge process
   age with it, trading one confound for another.

The mode is deliberately not defaulted quietly anywhere: `set_mode` logs every
change at INFO, and `EsphomeTransport` logs the mode it resolved on each
connection. The soak scores a run by reading that per-connection line back out
of the bridge log, never by trusting what it asked for -- a harness that records
its own intent cannot detect a knob that did not take.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

#: True  -> GATT Write Request  (ATT opcode 0x12, peer acknowledges)
#: False -> GATT Write Command  (ATT opcode 0x52, fire and forget)
#:
#: Defaults to True as of TRA-1153 item 5. Two independent reasons: the CS108's
#: 0x9900 advertises `properties=['write']` and NOT write-without-response, so a
#: Write Command was never a mode it claimed to accept; and the 1000-run
#: interleaved soak of 2026-08-27 bounded the cost of Write Requests under a dense
#: tag field at under 1% on throughput, run duration AND ESP32 loop time.
_with_response = True


def get_mode() -> bool:
    return _with_response


def set_mode(value: bool) -> bool:
    """Set the mode, returning the previous one. Logs on change, at INFO."""
    global _with_response
    previous = _with_response
    if value != previous:
        logger.info("write mode: %s -> %s", describe(previous), describe(value))
    _with_response = value
    return previous


def describe(value: bool | None = None) -> str:
    """The name that appears in logs and in soak results. One vocabulary only."""
    if value is None:
        value = _with_response
    return "with-response" if value else "without-response"
