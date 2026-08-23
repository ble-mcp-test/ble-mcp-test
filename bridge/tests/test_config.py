import pytest

from ble_bridge.config import ConfigError, from_env


def test_default_bind_is_loopback():
    """The Rust bridge defaulted ws_host to 0.0.0.0. That must not carry over.

    rust-ble-test/src/config.rs:70 is `unwrap_or_else(|| "0.0.0.0".to_string())` and
    :163 asserts the resolved default is "0.0.0.0:8080", so an operator who sets
    nothing gets a LAN-wide bind. A wide bind should require an explicit opt-in.
    """
    assert from_env({}).ws_bind == "127.0.0.1:8080"


def test_wide_bind_requires_explicit_opt_in():
    assert from_env({"BLE_MCP_WS_HOST": "0.0.0.0"}).ws_bind == "0.0.0.0:8080"


def test_empty_host_is_treated_as_absent():
    assert from_env({"BLE_MCP_WS_HOST": "   "}).ws_host == "127.0.0.1"


def test_port_override():
    assert from_env({"BLE_MCP_WS_PORT": "9999"}).ws_port == 9999


def test_unparseable_port_fails_loudly():
    """A present-but-wrong value must never fall back to the default."""
    with pytest.raises(ConfigError, match="BLE_MCP_WS_PORT"):
        from_env({"BLE_MCP_WS_PORT": "not-a-port"})


def test_out_of_range_port_fails_loudly():
    with pytest.raises(ConfigError, match="BLE_MCP_WS_PORT"):
        from_env({"BLE_MCP_WS_PORT": "70000"})


def test_is_loopback_reports_the_bind_surface():
    assert from_env({}).is_loopback is True
    assert from_env({"BLE_MCP_WS_HOST": "127.0.0.1"}).is_loopback is True
    assert from_env({"BLE_MCP_WS_HOST": "0.0.0.0"}).is_loopback is False
    assert from_env({"BLE_MCP_WS_HOST": "192.168.1.10"}).is_loopback is False
