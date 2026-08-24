"""Wiring the log configuration to `logging`, which is the part that was missing.

`__main__.py` used to call `logging.basicConfig(level=logging.INFO, ...)` with the
level hardcoded, while `.env.local` said `BLE_MCP_LOG_LEVEL=debug` throughout the
soak. That is failure class two in its cheapest form: the operator's evidence says
configured, the process uses something else, and nothing is slow.

Two decisions worth stating rather than leaving to be re-derived.

**The level goes on the ROOT logger, not on `ble_bridge`.** The records that matter
most on a wedge are not ours: `bleak_esphome` logs `BLE device disconnected` and
`ESP device disconnected` at DEBUG. Scoping the level to our own logger would make
`BLE_MCP_LOG_LEVEL=debug` appear to work while still hiding the mid-session link
drop it was set to find.

**The ring buffer hangs off `ble_bridge`, not the root.** The buffer is the bridge's
own account of what it did, read back over MCP; filling it with `asyncio` and
`aioesphomeapi` internals at DEBUG would push the bridge's own lines out of a
bounded ring exactly when they are wanted.
"""

from __future__ import annotations

import logging

from ble_bridge.config import Config
from ble_bridge.log_buffer import BufferHandler, LogBuffer

#: The bridge's own logger. Every module here is a child of it.
BRIDGE_LOGGER = "ble_bridge"

#: HH:MM:SS.mmm, matching logger.ts:16 so log lines from either era line up.
_TIME_FORMAT = "%H:%M:%S"
_WITH_TIMESTAMP = "%(asctime)s.%(msecs)03d %(levelname)s %(name)s: %(message)s"
_WITHOUT_TIMESTAMP = "%(levelname)s %(name)s: %(message)s"


def configure(config: Config) -> LogBuffer:
    """Apply the log configuration and return the buffer TRA-1161 will read.

    Idempotent. The bridge is started by a test harness that may reach this more
    than once in a process, and a second console handler would emit every line
    twice -- which reads as duplicated events rather than as duplicated handlers.
    """
    root = logging.getLogger()
    root.setLevel(config.log_level)

    fmt = _WITH_TIMESTAMP if config.log_timestamps else _WITHOUT_TIMESTAMP
    formatter = logging.Formatter(fmt, datefmt=_TIME_FORMAT)

    existing = next((h for h in root.handlers if getattr(h, "_ble_bridge_console", False)), None)
    if existing is None:
        console = logging.StreamHandler()
        console._ble_bridge_console = True  # type: ignore[attr-defined]
        root.addHandler(console)
    else:
        console = existing
    console.setFormatter(formatter)

    bridge = logging.getLogger(BRIDGE_LOGGER)
    for handler in [h for h in bridge.handlers if isinstance(h, BufferHandler)]:
        bridge.removeHandler(handler)

    buffer = LogBuffer(config.log_buffer_size)
    if buffer.enabled:
        bridge.addHandler(BufferHandler(buffer))
    return buffer
