"""BLE_MCP_LOG_LEVEL has to change what actually reaches the log.

This is the acceptance criterion that says "verified by execution, not grep", so
these tests run the configuration and then emit records through it, rather than
asserting that a value was read into a variable. Reading it into a variable is
what the previous version already did everywhere else in the tree; the thing that
was missing is the wire between the variable and `logging`.

`configure` mutates process-global logging state, so every test here restores it.
"""

import logging

import pytest

from ble_bridge.config import Config
from ble_bridge.log_buffer import DEBUG, INFO, LogBuffer
from ble_bridge.logging_setup import BRIDGE_LOGGER, configure


@pytest.fixture(autouse=True)
def restore_logging():
    """Put the root and bridge loggers back exactly as they were."""
    root = logging.getLogger()
    bridge = logging.getLogger(BRIDGE_LOGGER)
    saved = (root.level, list(root.handlers), bridge.level, list(bridge.handlers))
    yield
    root.level, root.handlers, bridge.level, bridge.handlers = (
        saved[0],
        list(saved[1]),
        saved[2],
        list(saved[3]),
    )


def _emitted(capture: LogBuffer) -> list[tuple[str, str]]:
    return [(e.direction, e.text) for e in capture.entries()]


def test_debug_reaches_the_log_when_it_is_asked_for():
    buffer = configure(Config(log_level=logging.DEBUG, log_buffer_size=100))
    logging.getLogger(BRIDGE_LOGGER).debug("BLE device disconnected")
    assert (DEBUG, "BLE device disconnected") in _emitted(buffer)


def test_debug_does_not_reach_the_log_at_info():
    """The control. Without this, the test above passes for a logger that is simply
    always on, and would have passed against the broken build too."""
    buffer = configure(Config(log_level=logging.INFO, log_buffer_size=100))
    logging.getLogger(BRIDGE_LOGGER).debug("BLE device disconnected")
    logging.getLogger(BRIDGE_LOGGER).info("still here")
    assert _emitted(buffer) == [(INFO, "still here")]


def test_the_level_reaches_third_party_libraries_too():
    """`bleak_esphome` logs `BLE device disconnected` and `ESP device disconnected`
    at DEBUG. If the level only applied to `ble_bridge`, a mid-session link drop
    would stay invisible -- which is precisely what the soak saw."""
    configure(Config(log_level=logging.DEBUG))
    assert logging.getLogger("bleak_esphome").isEnabledFor(logging.DEBUG)


def test_the_level_does_not_reach_libraries_when_it_was_not_asked_for():
    configure(Config(log_level=logging.INFO))
    assert not logging.getLogger("bleak_esphome").isEnabledFor(logging.DEBUG)


def test_timestamps_are_on_by_default(capsys):
    configure(Config())
    logging.getLogger(BRIDGE_LOGGER).info("hello")
    line = capsys.readouterr().err
    assert "hello" in line
    # HH:MM:SS.mmm, the spelling logger.ts:16 produced.
    assert line[2] == ":" and line[5] == ":" and line[8] == "."


def test_timestamps_can_be_turned_off(capsys):
    configure(Config(log_timestamps=False))
    logging.getLogger(BRIDGE_LOGGER).info("hello")
    assert capsys.readouterr().err.startswith("INFO ")


def test_configure_is_idempotent(capsys):
    """The bridge is started by a test harness that may import it more than once.
    Two handlers means every line twice, which reads as duplicated events."""
    configure(Config())
    configure(Config())
    logging.getLogger(BRIDGE_LOGGER).info("once")
    assert capsys.readouterr().err.count("once") == 1


def test_a_disabled_buffer_is_returned_but_not_attached():
    buffer = configure(Config(log_buffer_size=0))
    logging.getLogger(BRIDGE_LOGGER).info("nothing to see")
    assert buffer.enabled is False
    assert buffer.entries() == []


def test_the_buffer_is_sized_from_the_config():
    assert configure(Config(log_buffer_size=250)).maxsize == 250
