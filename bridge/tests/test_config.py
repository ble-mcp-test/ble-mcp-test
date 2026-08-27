import os

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

#: from_env has no default port since TRA-1179 -- it refuses to start without
#: one. These tests are about OTHER variables, so they supply a valid port and
#: say nothing about it. The port's own contract is pinned separately below.
PORT = {"BLE_MCP_WS_PORT": "25153"}


def test_default_bind_is_loopback():
    """The Rust bridge defaulted ws_host to 0.0.0.0. That must not carry over.

    rust-ble-test/src/config.rs:70 is `unwrap_or_else(|| "0.0.0.0".to_string())` and
    :163 asserts the resolved default is "0.0.0.0:8080", so an operator who sets
    nothing gets a LAN-wide bind. A wide bind should require an explicit opt-in.
    """
    assert from_env({**PORT}).ws_bind == "127.0.0.1:25153"


def test_wide_bind_requires_explicit_opt_in():
    assert from_env({**PORT, "BLE_MCP_WS_HOST": "0.0.0.0"}).ws_bind == "0.0.0.0:25153"


def test_empty_host_is_treated_as_absent():
    assert from_env({**PORT, "BLE_MCP_WS_HOST": "   "}).ws_host == "127.0.0.1"


def test_port_override():
    assert from_env({**PORT, "BLE_MCP_WS_PORT": "9999"}).ws_port == 9999


def test_unparseable_port_fails_loudly():
    """A present-but-wrong value must never fall back to the default."""
    with pytest.raises(ConfigError, match="BLE_MCP_WS_PORT"):
        from_env({**PORT, "BLE_MCP_WS_PORT": "not-a-port"})


@pytest.mark.parametrize("port", ["1023", "0", "32768", "70000"])
def test_out_of_range_port_fails_loudly(port):
    """Both ends are load-bearing and neither is arbitrary.

    Below 1024 is privileged and needs root. 32768 is where THIS host's
    ephemeral range starts, and a listen port inside it can be transiently
    stolen by an outbound socket's source port -- rare, non-deterministic, and
    presenting as a bridge that is intermittently unreachable.
    """
    with pytest.raises(ConfigError, match="BLE_MCP_WS_PORT"):
        from_env({**PORT, "BLE_MCP_WS_PORT": port})


@pytest.mark.parametrize("port", ["1024", "25153", "32767"])
def test_the_edges_of_the_accepted_range_are_accepted(port):
    """Guards the off-by-one in the other direction: a bound that rejects its
    own endpoints would pass every test above while refusing a legal port."""
    assert from_env({**PORT, "BLE_MCP_WS_PORT": port}).ws_port == int(port)


def test_an_absent_port_refuses_rather_than_defaulting():
    """The defect this replaced: a MALFORMED port already refused to fall back,
    while an ABSENT one fell back to 8080 silently. Loud on a typo, silent on an
    omission -- exactly backwards, and 8080 is a port the consumer's own backend
    already owned."""
    with pytest.raises(ConfigError, match="BLE_MCP_WS_PORT"):
        from_env({})


def test_is_loopback_reports_the_bind_surface():
    assert from_env({**PORT}).is_loopback is True
    assert from_env({**PORT, "BLE_MCP_WS_HOST": "127.0.0.1"}).is_loopback is True
    assert from_env({**PORT, "BLE_MCP_WS_HOST": "0.0.0.0"}).is_loopback is False
    assert from_env({**PORT, "BLE_MCP_WS_HOST": "192.168.1.10"}).is_loopback is False


# --- TRA-1158: the ESPHome proxy and the target device -------------------------


def test_no_esphome_host_means_no_esphome_config():
    """Absent is absent. The caller decides what to do with None; config does not guess."""
    assert from_env({**PORT}).esphome is None


def test_host_and_mac_together_produce_a_config():
    cfg = from_env(
        {**PORT, ESPHOME_HOST_ENV: "192.168.50.170", DEVICE_MAC_ENV: "6c:79:b8:11:22:33"}
    )
    assert cfg.esphome is not None
    assert cfg.esphome.proxy_host == "192.168.50.170"
    assert cfg.esphome.proxy_port == DEFAULT_ESPHOME_PORT
    assert cfg.esphome.device_mac == "6C:79:B8:11:22:33"


def test_host_may_carry_the_port_inline():
    cfg = from_env({**PORT, ESPHOME_HOST_ENV: "proxy.local:6054", DEVICE_MAC_ENV: "6c79b8112233"})
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
        from_env({**PORT, ESPHOME_HOST_ENV: "192.168.50.170"})
    assert DEVICE_MAC_ENV in str(exc.value)


def test_a_device_mac_with_no_proxy_host_is_an_error_not_a_stub():
    with pytest.raises(ConfigError) as exc:
        from_env({**PORT, DEVICE_MAC_ENV: "6c:79:b8:11:22:33"})
    assert ESPHOME_HOST_ENV in str(exc.value)


def test_an_unparseable_mac_raises_rather_than_reaching_the_proxy():
    with pytest.raises(ConfigError) as exc:
        from_env({**PORT, ESPHOME_HOST_ENV: "p", DEVICE_MAC_ENV: "not-a-mac"})
    assert "not-a-mac" in str(exc.value)


def test_two_ports_that_disagree_is_an_error():
    """Rust silently preferred the inline one. Preferring either is a guess."""
    with pytest.raises(ConfigError) as exc:
        from_env(
            {
                **PORT,
                ESPHOME_HOST_ENV: "proxy.local:6054",
                ESPHOME_PORT_ENV: "6055",
                DEVICE_MAC_ENV: "6c79b8112233",
            }
        )
    assert "6054" in str(exc.value) and "6055" in str(exc.value)


def test_two_ports_that_agree_is_fine():
    cfg = from_env(
        {
            **PORT,
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
            **PORT,
            ESPHOME_HOST_ENV: "proxy.local",
            DEVICE_MAC_ENV: "6c79b8112233",
            ESPHOME_PSK_ENV: "c3VwZXJzZWNyZXQ=",
        }
    )
    assert cfg.esphome is not None
    assert cfg.esphome.noise_psk == "c3VwZXJzZWNyZXQ="


def test_mac_as_int_is_the_address_the_proxy_wants():
    cfg = from_env({**PORT, ESPHOME_HOST_ENV: "p", DEVICE_MAC_ENV: "6c:79:b8:11:22:33"})
    assert cfg.esphome is not None
    assert cfg.esphome.address == 0x6C79B8112233


# --- the MCP control socket (TRA-1161) ---------------------------------------


def test_the_socket_path_defaults_under_xdg_runtime_dir():
    cfg = from_env({**PORT, "XDG_RUNTIME_DIR": "/run/user/1000"})
    assert cfg.socket_path == "/run/user/1000/ble-bridge.sock"


def test_without_xdg_runtime_dir_the_socket_falls_back_to_a_uid_scoped_tmp_path():
    cfg = from_env({**PORT})
    assert cfg.socket_path == f"/tmp/ble-bridge-{os.getuid()}.sock"


def test_a_blank_xdg_runtime_dir_is_absent_not_a_root_relative_path():
    """XDG_RUNTIME_DIR="" would otherwise join to "/ble-bridge.sock"."""
    cfg = from_env({**PORT, "XDG_RUNTIME_DIR": "  "})
    assert cfg.socket_path == f"/tmp/ble-bridge-{os.getuid()}.sock"


def test_the_socket_path_can_be_set_outright():
    cfg = from_env({**PORT, "BLE_MCP_SOCKET_PATH": "/tmp/somewhere.sock"})
    assert cfg.socket_path == "/tmp/somewhere.sock"


def test_a_relative_socket_path_is_refused():
    """The bridge and the MCP shim are separate processes with separate working
    directories. A relative path names two different files and presents as a
    bridge that is down."""
    with pytest.raises(ConfigError):
        from_env({**PORT, "BLE_MCP_SOCKET_PATH": "ble-bridge.sock"})
