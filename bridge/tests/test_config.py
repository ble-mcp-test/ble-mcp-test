import pytest

from ble_bridge.config import (
    DEFAULT_ESPHOME_PORT,
    DEVICE_MAC_ENV,
    ESPHOME_HOST_ENV,
    ESPHOME_PORT_ENV,
    ESPHOME_PSK_ENV,
    ConfigError,
    from_env,
)


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


# --- TRA-1158: the ESPHome proxy and the target device -------------------------


def test_no_esphome_host_means_no_esphome_config():
    """Absent is absent. The caller decides what to do with None; config does not guess."""
    assert from_env({}).esphome is None


def test_host_and_mac_together_produce_a_config():
    cfg = from_env({ESPHOME_HOST_ENV: "192.168.50.170", DEVICE_MAC_ENV: "6c:79:b8:11:22:33"})
    assert cfg.esphome is not None
    assert cfg.esphome.proxy_host == "192.168.50.170"
    assert cfg.esphome.proxy_port == DEFAULT_ESPHOME_PORT
    assert cfg.esphome.device_mac == "6C:79:B8:11:22:33"


def test_host_may_carry_the_port_inline():
    cfg = from_env({ESPHOME_HOST_ENV: "proxy.local:6054", DEVICE_MAC_ENV: "6c79b8112233"})
    assert cfg.esphome is not None
    assert cfg.esphome.proxy_host == "proxy.local"
    assert cfg.esphome.proxy_port == 6054


def test_a_proxy_host_with_no_device_mac_is_an_error_not_a_stub():
    """The whole failure class: a bridge that silently relays nothing looks configured.

    Falling back to the stub here would produce a process that starts, accepts
    clients and returns no notifications -- every symptom of a dead reader, with
    nothing anywhere saying the radio was never wired up.
    """
    with pytest.raises(ConfigError) as exc:
        from_env({ESPHOME_HOST_ENV: "192.168.50.170"})
    assert DEVICE_MAC_ENV in str(exc.value)


def test_a_device_mac_with_no_proxy_host_is_an_error_not_a_stub():
    with pytest.raises(ConfigError) as exc:
        from_env({DEVICE_MAC_ENV: "6c:79:b8:11:22:33"})
    assert ESPHOME_HOST_ENV in str(exc.value)


def test_an_unparseable_mac_raises_rather_than_reaching_the_proxy():
    with pytest.raises(ConfigError) as exc:
        from_env({ESPHOME_HOST_ENV: "p", DEVICE_MAC_ENV: "not-a-mac"})
    assert "not-a-mac" in str(exc.value)


def test_two_ports_that_disagree_is_an_error():
    """Rust silently preferred the inline one. Preferring either is a guess."""
    with pytest.raises(ConfigError) as exc:
        from_env(
            {
                ESPHOME_HOST_ENV: "proxy.local:6054",
                ESPHOME_PORT_ENV: "6055",
                DEVICE_MAC_ENV: "6c79b8112233",
            }
        )
    assert "6054" in str(exc.value) and "6055" in str(exc.value)


def test_two_ports_that_agree_is_fine():
    cfg = from_env(
        {
            ESPHOME_HOST_ENV: "proxy.local:6053",
            ESPHOME_PORT_ENV: "6053",
            DEVICE_MAC_ENV: "6c79b8112233",
        }
    )
    assert cfg.esphome is not None
    assert cfg.esphome.proxy_port == 6053


def test_noise_psk_is_carried_rather_than_rejected():
    """Unlike the Rust backend, which refused to start with a PSK configured."""
    cfg = from_env(
        {
            ESPHOME_HOST_ENV: "proxy.local",
            DEVICE_MAC_ENV: "6c79b8112233",
            ESPHOME_PSK_ENV: "c3VwZXJzZWNyZXQ=",
        }
    )
    assert cfg.esphome is not None
    assert cfg.esphome.noise_psk == "c3VwZXJzZWNyZXQ="


def test_mac_as_int_is_the_address_the_proxy_wants():
    cfg = from_env({ESPHOME_HOST_ENV: "p", DEVICE_MAC_ENV: "6c:79:b8:11:22:33"})
    assert cfg.esphome is not None
    assert cfg.esphome.address == 0x6C79B8112233
