"""Startup guards: the bridge must reach a real device, or refuse to run.

Both tests cover the same failure, which nearly shipped a false hardware
verification on 2026-08-26: a bridge with no device configured used to fall back
to the stub transport and log a WARNING into a debug-level stream. Trigger
injection is mock-side, so a browser spec passes green against a bridge
connected to nothing -- the only tell was the absence of one log line.
"""

from __future__ import annotations

import os

import pytest

import ble_bridge.__main__ as ble_main
from ble_bridge.__main__ import _load_env_file, _select_transport, main
from ble_bridge.config import from_env
from ble_bridge.log_buffer import LogBuffer


@pytest.fixture
def clean_environ():
    """Restore os.environ afterwards -- load_dotenv mutates it directly."""
    saved = dict(os.environ)
    yield
    os.environ.clear()
    os.environ.update(saved)


async def test_refuses_to_start_when_no_device_is_configured():
    config = from_env(env={})
    assert config.esphome is None

    with pytest.raises(SystemExit) as excinfo:
        await _select_transport(config)

    # Name both variables: the operator should not have to go read the source
    # to find out which one is missing.
    message = str(excinfo.value)
    assert "ESPHOME_PROXY_HOST" in message
    assert "BLE_MCP_DEVICE_MAC" in message


def test_loads_env_local_from_a_parent_directory(tmp_path, monkeypatch, clean_environ):
    """`uv run ble-bridge` is launched from bridge/, and .env.local sits above it.

    This is what makes the bridge independent of the launching shell: direnv
    hooks PROMPT_COMMAND, which never fires in a one-shot agent tool shell, so
    the environment there is whatever the *session* started with. Reading the
    file ourselves removes that dependency entirely.
    """
    repo = tmp_path / "repo"
    (repo / "bridge").mkdir(parents=True)
    (repo / ".env.local").write_text(
        "ESPHOME_PROXY_HOST=10.0.0.9\nBLE_MCP_DEVICE_MAC=AA:BB:CC:DD:EE:FF\n"
    )
    monkeypatch.chdir(repo / "bridge")
    monkeypatch.delenv("ESPHOME_PROXY_HOST", raising=False)
    monkeypatch.delenv("BLE_MCP_DEVICE_MAC", raising=False)

    found = _load_env_file()

    assert found == str(repo / ".env.local")
    assert os.environ["ESPHOME_PROXY_HOST"] == "10.0.0.9"
    assert os.environ["BLE_MCP_DEVICE_MAC"] == "AA:BB:CC:DD:EE:FF"


def test_a_real_environment_variable_beats_the_file(tmp_path, monkeypatch, clean_environ):
    """An explicitly exported value must win, or overriding for one run is impossible."""
    repo = tmp_path / "repo"
    (repo / "bridge").mkdir(parents=True)
    (repo / ".env.local").write_text("ESPHOME_PROXY_HOST=10.0.0.9\n")
    monkeypatch.chdir(repo / "bridge")
    monkeypatch.setenv("ESPHOME_PROXY_HOST", "192.168.1.1")

    _load_env_file()

    assert os.environ["ESPHOME_PROXY_HOST"] == "192.168.1.1"


def test_main_reads_the_file_before_reading_config(tmp_path, monkeypatch, clean_environ):
    """Covers the wiring, not just the parts.

    Testing `_load_env_file` alone would stay green if someone deleted the call
    from `main()` -- this ticket's own failure, reintroduced with a green suite.
    So drive `main()` and assert the file reached the environment; the log level
    below comes from nowhere else.

    `asyncio.run` is stubbed out deliberately. Letting `main()` proceed would
    start the server and block on its shutdown event, so a regression would
    present as a HANG rather than a failure -- the waiter-with-no-emitter shape
    this codebase already has a rule against.
    """
    repo = tmp_path / "repo"
    (repo / "bridge").mkdir(parents=True)
    (repo / ".env.local").write_text("BLE_MCP_LOG_LEVEL=debug\n")
    monkeypatch.chdir(repo / "bridge")
    monkeypatch.delenv("BLE_MCP_LOG_LEVEL", raising=False)

    started: list[object] = []

    def _capture(coro):
        coro.close()  # never awaited; closing avoids a "never awaited" warning
        started.append(coro)

    monkeypatch.setattr(ble_main.asyncio, "run", _capture)

    main()

    assert started, "main() should have handed the run coroutine to asyncio.run"
    assert os.environ["BLE_MCP_LOG_LEVEL"] == "debug"


async def test_refusal_happens_before_the_server_listens(monkeypatch):
    """The bridge must not bind a port and then discover it has no device.

    Constructing BridgeServer is the point of no return for an operator reading
    logs -- a listening socket says "ready". Assert we never reach it.
    """

    def _explode(*args, **kwargs):
        raise AssertionError("BridgeServer must not be constructed without a device")

    monkeypatch.setattr(ble_main, "BridgeServer", _explode)

    with pytest.raises(SystemExit):
        await ble_main._run(from_env(env={}), LogBuffer(maxsize=1))


def test_missing_env_local_is_not_an_error(tmp_path, monkeypatch, clean_environ):
    """No file is a legitimate state -- the environment may be set some other way.

    The refusal in _select_transport is what catches an unconfigured bridge, so
    this loader stays quiet rather than growing a second opinion about it.
    """
    monkeypatch.chdir(tmp_path)

    assert _load_env_file() is None
