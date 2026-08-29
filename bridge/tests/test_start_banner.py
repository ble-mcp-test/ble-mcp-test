"""A restart has to be legible in the daemon's own log, not only in systemd's.

Under `deploy/ble-bridge.service` the daemon restarts without anyone typing it.
systemd records that, but the log is what gets read by someone who did not think
to ask systemd -- and the ring buffer served over MCP is the bridge's own account
of what it did. So the start banner is not decoration: it is the second of two
independent records of the same event.

Each assertion here pins a field for a reason, because a banner that says
"starting" and nothing else cannot tell two daemons apart, which is the only
question anyone asks it.
"""

from __future__ import annotations

import logging
import os

from ble_bridge.__main__ import _log_start_banner


def _banner(caplog) -> str:
    records = [r for r in caplog.records if "STARTING" in r.getMessage()]
    assert len(records) == 1, f"expected exactly one start banner, got {len(records)}"
    return records[0].getMessage()


def test_the_banner_is_greppable_and_logged_at_info(caplog):
    # INFO, not DEBUG: the service runs at info, so a banner at debug would be
    # absent from the exact log it exists for.
    with caplog.at_level(logging.INFO, logger="ble_bridge"):
        _log_start_banner("/somewhere/.env.local")
    record = next(r for r in caplog.records if "STARTING" in r.getMessage())
    assert record.levelno == logging.INFO
    assert record.name.startswith("ble_bridge")
    assert "=== ble-bridge STARTING ===" in record.getMessage()


def test_the_banner_names_the_pid_so_it_pairs_with_mainpid(caplog):
    with caplog.at_level(logging.INFO, logger="ble_bridge"):
        _log_start_banner("/somewhere/.env.local")
    assert f"pid={os.getpid()}" in _banner(caplog)


def test_the_banner_names_the_checkout_this_process_is_serving(caplog):
    # The discriminating field. Two checkouts of this repo can both hold a
    # daemon, and "which code is this one running" is answerable only from here
    # and from /proc/<pid>/cwd, which scripts/bridge-staleness.js reads.
    with caplog.at_level(logging.INFO, logger="ble_bridge"):
        _log_start_banner("/somewhere/.env.local")
    assert f"cwd={os.getcwd()}" in _banner(caplog)


def test_the_banner_names_the_env_file_it_actually_read(caplog):
    with caplog.at_level(logging.INFO, logger="ble_bridge"):
        _log_start_banner("/somewhere/.env.local")
    assert "env=/somewhere/.env.local" in _banner(caplog)


def test_a_missing_env_file_says_NONE_rather_than_going_unmentioned(caplog):
    # Silence would leave an upstream failure named after a downstream
    # subsystem: no device MAC presents as a dead reader, not as an unread file.
    with caplog.at_level(logging.INFO, logger="ble_bridge"):
        _log_start_banner(None)
    assert "env=NONE" in _banner(caplog)


def test_the_banner_does_not_offer_the_package_version_as_identity(caplog):
    # __version__ has been "0.1.0" through the entire replatform: it reports the
    # same string for today's code and for six-month-old code. Printing it here
    # would invite exactly the false confidence the staleness guard exists to
    # remove.
    with caplog.at_level(logging.INFO, logger="ble_bridge"):
        _log_start_banner("/somewhere/.env.local")
    assert "0.1.0" not in _banner(caplog)
