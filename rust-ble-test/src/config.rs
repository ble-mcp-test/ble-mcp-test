//! Runtime configuration parsed from environment variables.
//!
//! Backend selection and all device/target parameters come from the environment so the
//! same binary can drive either a local radio (btleplug, default) or a networked ESPHome
//! Bluetooth Proxy (esphome) with no code change.

use uuid::Uuid;

/// Which BLE backend the bridge drives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// Local BLE radio via btleplug/BlueZ/D-Bus. Default.
    Btleplug,
    /// ESPHome Bluetooth Proxy over the native API (TCP/6053, protobuf). No local radio.
    Esphome,
}

/// Fully-resolved runtime configuration.
#[derive(Debug, Clone)]
pub struct Config {
    pub backend: Backend,
    /// Target device MAC, e.g. "6C:79:B8:26:03:A7".
    pub device_mac: String,
    pub service_uuid: Uuid,
    pub write_uuid: Uuid,
    pub notify_uuid: Uuid,
    /// WebSocket bind address for test clients, e.g. "0.0.0.0:8080".
    pub ws_bind: String,
    /// btleplug adapter selector (name / index / MAC substring). None => first adapter.
    pub adapter_selector: Option<String>,
    /// ESPHome proxy host (no port).
    pub esphome_host: String,
    /// ESPHome proxy native-API port (default 6053).
    pub esphome_port: u16,
    /// Optional Noise PSK (base64). Presence currently rejected: Noise is a documented follow-up.
    pub esphome_psk: Option<String>,
}

const DEFAULT_MAC: &str = "6C:79:B8:26:03:A7";
const DEFAULT_ESPHOME_PORT: u16 = 6053;

impl Config {
    /// Resolve from the process environment.
    pub fn from_env() -> Result<Config, String> {
        Self::from_env_with(|k| std::env::var(k).ok())
    }

    /// Resolve from an arbitrary getter (used for tests).
    pub fn from_env_with<F: Fn(&str) -> Option<String>>(get: F) -> Result<Config, String> {
        let backend = match get("BLE_BACKEND").as_deref() {
            None | Some("") | Some("btleplug") => Backend::Btleplug,
            Some("esphome") => Backend::Esphome,
            Some(other) => {
                return Err(format!(
                    "unknown BLE_BACKEND '{other}' (expected 'btleplug' or 'esphome')"
                ))
            }
        };

        let device_mac = get("BLE_MCP_DEVICE_MAC")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_MAC.to_string());

        let service_uuid = parse_uuid_env(&get, "BLE_MCP_SERVICE_UUID", 0x9800)?;
        let write_uuid = parse_uuid_env(&get, "BLE_MCP_WRITE_UUID", 0x9900)?;
        let notify_uuid = parse_uuid_env(&get, "BLE_MCP_NOTIFY_UUID", 0x9901)?;

        let ws_host = get("BLE_MCP_WS_HOST")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "0.0.0.0".to_string());
        let ws_port = match get("BLE_MCP_WS_PORT").filter(|s| !s.is_empty()) {
            Some(s) => s
                .parse::<u16>()
                .map_err(|_| format!("invalid BLE_MCP_WS_PORT '{s}'"))?,
            None => 8080,
        };
        let ws_bind = format!("{ws_host}:{ws_port}");

        let adapter_selector = get("BLE_MCP_ADAPTER").filter(|s| !s.is_empty());

        // ESPHome host may carry an inline ":port"; otherwise ESPHOME_PROXY_PORT or the default.
        let raw_host = get("ESPHOME_PROXY_HOST").filter(|s| !s.is_empty());
        let (esphome_host, inline_port) = match &raw_host {
            Some(h) if h.contains(':') => {
                let (host, port) = h.rsplit_once(':').unwrap();
                let port = port
                    .parse::<u16>()
                    .map_err(|_| format!("invalid port in ESPHOME_PROXY_HOST '{h}'"))?;
                (host.to_string(), Some(port))
            }
            Some(h) => (h.clone(), None),
            None => (String::new(), None),
        };
        let esphome_port = match inline_port {
            Some(p) => p,
            None => match get("ESPHOME_PROXY_PORT").filter(|s| !s.is_empty()) {
                Some(s) => s
                    .parse::<u16>()
                    .map_err(|_| format!("invalid ESPHOME_PROXY_PORT '{s}'"))?,
                None => DEFAULT_ESPHOME_PORT,
            },
        };
        let esphome_psk = get("ESPHOME_NOISE_PSK").filter(|s| !s.is_empty());

        if backend == Backend::Esphome && esphome_host.is_empty() {
            return Err("BLE_BACKEND=esphome requires ESPHOME_PROXY_HOST".to_string());
        }

        Ok(Config {
            backend,
            device_mac,
            service_uuid,
            write_uuid,
            notify_uuid,
            ws_bind,
            adapter_selector,
            esphome_host,
            esphome_port,
            esphome_psk,
        })
    }

    /// Expand a 16-bit UUID into the Bluetooth base UUID `0000xxxx-0000-1000-8000-00805f9b34fb`.
    pub fn parse_16bit_uuid(short: u16) -> Uuid {
        Uuid::from_u128(0x0000_0000_0000_1000_8000_0080_5f9b_34fb_u128 | ((short as u128) << 96))
    }
}

/// Parse a UUID env var: accept a 4-hex short form (optionally `0x`-prefixed) or a full UUID.
fn parse_uuid_env<F: Fn(&str) -> Option<String>>(
    get: &F,
    key: &str,
    default_short: u16,
) -> Result<Uuid, String> {
    match get(key).filter(|s| !s.is_empty()) {
        None => Ok(Config::parse_16bit_uuid(default_short)),
        Some(v) => {
            let vt = v.trim();
            let stripped = vt
                .strip_prefix("0x")
                .or_else(|| vt.strip_prefix("0X"))
                .unwrap_or(vt);
            if stripped.len() == 4 && stripped.chars().all(|c| c.is_ascii_hexdigit()) {
                let short = u16::from_str_radix(stripped, 16)
                    .map_err(|_| format!("invalid short uuid in {key}='{v}'"))?;
                Ok(Config::parse_16bit_uuid(short))
            } else {
                Uuid::parse_str(vt).map_err(|_| format!("invalid uuid in {key}='{v}'"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_btleplug() {
        let c = Config::from_env_with(|_| None).unwrap();
        assert!(matches!(c.backend, Backend::Btleplug));
        assert_eq!(c.device_mac, "6C:79:B8:26:03:A7");
        assert_eq!(c.ws_bind, "0.0.0.0:8080");
        assert_eq!(c.esphome_port, 6053);
    }

    #[test]
    fn selects_esphome_and_parses_host_port() {
        let env = |k: &str| match k {
            "BLE_BACKEND" => Some("esphome".to_string()),
            "ESPHOME_PROXY_HOST" => Some("192.168.50.170:6053".to_string()),
            _ => None,
        };
        let c = Config::from_env_with(env).unwrap();
        assert!(matches!(c.backend, Backend::Esphome));
        assert_eq!(c.esphome_host, "192.168.50.170");
        assert_eq!(c.esphome_port, 6053);
    }

    #[test]
    fn short_uuid_expands_to_base() {
        assert_eq!(
            Config::parse_16bit_uuid(0x9800),
            uuid::Uuid::from_u128(0x0000_9800_0000_1000_8000_0080_5f9b_34fb)
        );
    }

    #[test]
    fn unknown_backend_is_error() {
        let env = |k: &str| (k == "BLE_BACKEND").then(|| "noble".to_string());
        assert!(Config::from_env_with(env).is_err());
    }

    #[test]
    fn esphome_backend_requires_host() {
        let env = |k: &str| (k == "BLE_BACKEND").then(|| "esphome".to_string());
        assert!(Config::from_env_with(env).is_err());
    }

    #[test]
    fn esphome_default_port_when_host_has_no_colon() {
        let env = |k: &str| match k {
            "BLE_BACKEND" => Some("esphome".to_string()),
            "ESPHOME_PROXY_HOST" => Some("waveshare-s3-eth-probe.local".to_string()),
            _ => None,
        };
        let c = Config::from_env_with(env).unwrap();
        assert_eq!(c.esphome_host, "waveshare-s3-eth-probe.local");
        assert_eq!(c.esphome_port, 6053);
    }

    #[test]
    fn adapter_selector_passthrough() {
        let env = |k: &str| (k == "BLE_MCP_ADAPTER").then(|| "hci1".to_string());
        let c = Config::from_env_with(env).unwrap();
        assert_eq!(c.adapter_selector.as_deref(), Some("hci1"));
    }
}
