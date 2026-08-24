"""The one piece of process-wide state bleak-esphome requires.

`bleak_esphome.connect_scanner` calls `habluetooth.get_manager()`, so a manager
must exist before any transport is built. That is genuinely process-scoped -- it
is a registry of scanners, not a connection -- and it is the single exception to
the per-connection rule in `docs/design/2026-08-23-transport-lifecycle-decision.md`.

**It is not an exception that matters**, and the distinction is worth stating
because the next person will reasonably suspect it is process lifetime creeping
back in. The manager holds no radio, opens no socket and reaches no device. It is
an empty registry until a scanner registers with it, and scanners are registered
and unregistered per connection by `BleakEsphomeSession`. A daemon with no
clients has a manager and still holds nothing.

**Measured, in this container, on 2026-08-23:** `BluetoothManager().async_setup()`
completes with no Bluetooth stack present -- `AF_BLUETOOTH` returns errno 97 here
and the manager does not care, because the local-adapter machinery in its
dependency tree is only reached by local scanners, which we never create. That is
why the ESPHome path works in CI where the whole premise of this project lives.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_manager = None


def ensure_manager():
    """Return the process's habluetooth manager, creating it on first use.

    Note `async_setup()` is not awaited here: it is a coroutine in some versions
    and not in others, and this is called from an async context in either case.
    See `setup_manager`.
    """
    global _manager
    if _manager is None:
        raise RuntimeError(
            "the habluetooth manager has not been set up. Call setup_manager() "
            "once at startup before building an ESPHome transport."
        )
    return _manager


async def setup_manager():
    """Create and register the manager. Idempotent; call once at startup."""
    global _manager
    if _manager is not None:
        return _manager

    from habluetooth import BluetoothManager, set_manager

    manager = BluetoothManager()
    set_manager(manager)
    result = manager.async_setup()
    if result is not None and hasattr(result, "__await__"):
        await result
    _manager = manager
    logger.debug("habluetooth manager ready (holds no radio; registry only)")
    return manager


async def teardown_manager() -> None:
    """Drop the manager. Only for tests -- the daemon keeps it for its lifetime."""
    global _manager
    if _manager is None:
        return
    stop = getattr(_manager, "async_stop", None)
    if stop is not None:
        result = stop()
        if result is not None and hasattr(result, "__await__"):
            await result
    _manager = None
