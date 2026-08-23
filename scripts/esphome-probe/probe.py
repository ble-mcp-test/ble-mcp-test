# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "bleak-esphome>=4.0.0",
#   "bleak>=3.0.2",
#   "habluetooth>=6.26.5",
# ]
# ///
"""
ESPHome Bluetooth Proxy probe — can a GL-S10 / ESP32 proxy back the CS108 use case?

Python twin of scripts/ble-soak.js: same commands, same modes, same summary JSON,
written to tmp/soak/<label>.json so results sit next to the btleplug/adapter runs
and compare apples to apples. Talks to the proxy over the ESPHome native API via
bleak-esphome — no Home Assistant, no BlueZ, no local radio.

Usage (uv resolves the deps on first run):

  uv run scripts/esphome-probe/probe.py --proxy gl-s10-xxxxxx.local --mode poll --minutes 15 --label esphome-poll
  uv run scripts/esphome-probe/probe.py --proxy 192.168.1.50 --mode inventory --minutes 10 --label esphome-inv
  uv run scripts/esphome-probe/probe.py --proxy 192.168.1.50 --mode recover --cycles 10 --label esphome-recover
  uv run scripts/esphome-probe/probe.py --proxy 192.168.1.50 --mode thrash --minutes 5 --label esphome-thrash

Baselines to beat (ASUS dongle + btleplug, 2026-08-21, see STATE-OF-PLAY.md §11):
  poll      100 %, p50 40 ms, 72 min clean
  recover   10/10 recovered, p50 5.5 s, max 7.3 s
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from pathlib import Path

import bleak
import habluetooth
from bleak_esphome import APIConnectionManager, ESPHomeDeviceConfig

# ---------------------------------------------------------------- device

DEVICE_MAC = "6C:79:B8:XX:XX:XX"
SERVICE_UUID = "00009800-0000-1000-8000-00805f9b34fb"
WRITE_UUID = "00009900-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "00009901-0000-1000-8000-00805f9b34fb"

# Identical byte sequences to scripts/ble-soak.js — do not re-derive.
TEST_COMMAND = bytes([0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x01])
BATTERY_COMMAND = bytes([0xA7, 0xB3, 0x02, 0xD9, 0x82, 0x37, 0x00, 0x00, 0xA0, 0x00])
RFID_START_INVENTORY = bytes(
    [0xA7, 0xB3, 0x0A, 0xC2, 0x82, 0x37, 0x00, 0x00, 0x80, 0x02, 0x70, 0x01, 0x00, 0xF0, 0x0F, 0x00, 0x00, 0x00]
)
RFID_ABORT = bytes(
    [0xA7, 0xB3, 0x0A, 0xC2, 0x82, 0x37, 0x00, 0x00, 0x80, 0x02, 0x40, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
)
RFID_HST_CMD_ZERO = bytes(
    [0xA7, 0xB3, 0x0A, 0xC2, 0x82, 0x37, 0x00, 0x00, 0x80, 0x02, 0x70, 0x01, 0x00, 0xF0, 0x00, 0x00, 0x00, 0x00]
)

# Captured 2026-08-22 from the trakrf app's own inventory scan (verified reading tags through the
# bridge: 86 type-0x8005 packets with real EPCs). The prior fixed-Q sequence started an inventory
# but decoded zero tags — the app uses dynamic-Q + link profile 1 + MAC-bypass + compact INV_CFG.
# reg(addr,val) builds a low-level-API register write: A7 B3 0A C2 82 37 00 00 80 02 70 01 <addr LE> <val LE32>.
def _reg(addr: int, val: int) -> bytes:
    return bytes([0xA7, 0xB3, 0x0A, 0xC2, 0x82, 0x37, 0x00, 0x00, 0x80, 0x02, 0x70, 0x01,
                  addr & 0xFF, (addr >> 8) & 0xFF,
                  val & 0xFF, (val >> 8) & 0xFF, (val >> 16) & 0xFF, (val >> 24) & 0xFF])


INVENTORY_BRINGUP: list[tuple[str, bytes, float]] = [
    ("RFID_POWER_ON", bytes([0xA7, 0xB3, 0x02, 0xC2, 0x82, 0x37, 0x00, 0x00, 0x80, 0x00]), 0.8),
    ("ANT_PORT_POWER = 30 dBm", _reg(0x0706, 0x012C), 0.15),
    ("INV_SEL = DYNAMIC_Q", _reg(0x0902, 0x0003), 0.15),
    ("INV_ALG_PARM_0 = 0x40F7", _reg(0x0903, 0x40F7), 0.15),
    ("QUERY_CFG = 0", _reg(0x0900, 0x0000), 0.15),
    ("CURRENT_PROFILE = 1", _reg(0x0B60, 0x0001), 0.15),
    ("HST_CMD = MAC_BYPASS_WRITE", _reg(0xF000, 0x0006), 0.15),
    ("RSSI_THRESHOLD = 0x10", _reg(0x0908, 0x0010), 0.15),
    ("INV_CFG = 0x05400003 (compact)", _reg(0x0901, 0x05400003), 0.15),
    ("TAGACC_BANK = 0", _reg(0x0A02, 0x0000), 0.15),
    ("TAGACC_PTR = 0", _reg(0x0A03, 0x0000), 0.15),
    ("TAGACC_CNT = 0", _reg(0x0A04, 0x0000), 0.15),
    ("ANT_PORT_POWER = 30 dBm (re)", _reg(0x0706, 0x012C), 0.15),
    ("HST_CMD = START_INVENTORY", RFID_START_INVENTORY, 0.5),
]


def is_valid_response(d: bytes) -> bool:
    return len(d) == 11 and d[0] == 0xA7 and d[1] == 0xB3 and d[8] == 0xA0 and d[9] == 0x01 and d[10] == 0x00


def is_status_reply(d: bytes) -> bool:
    return len(d) >= 10 and d[0] == 0xA7 and d[1] == 0xB3 and d[8] == 0xA0


def is_inventory_tag(d: bytes) -> bool:
    """RFID uplink (0x8100) whose R2000 packet type is INVENTORY.

    Type is bytes 12-13 (LE): 0x0005 normal, 0x8005 compact (top bit set). The app and our
    captured bring-up use compact mode, so mask the top bit before comparing — requiring
    d[13]==0x00 missed every compact tag. Cycle-end diagnostics (0x000E), command begin/end
    and antenna-cycle packets also arrive on 0x8100 and must not count. Packets fragment at
    20 B (MTU 23) but the type bytes sit in the first fragment.
    """
    return (len(d) >= 14 and d[8] == 0x81 and d[9] == 0x00
            and d[12] == 0x05 and (d[13] & 0x7F) == 0x00)


# ---------------------------------------------------------------- args

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--proxy", required=True, help="proxy host (mDNS name or IP); add :port if not 6053")
ap.add_argument("--psk", default=None, help="api: encryption key, if the proxy config sets one")
ap.add_argument("--mode", default="poll", choices=["poll", "thrash", "inventory", "recover"])
ap.add_argument("--minutes", type=float, default=15)
ap.add_argument("--interval", type=int, default=1000, help="ms between commands (poll/thrash)")
ap.add_argument("--label", default="esphome-unlabeled")
ap.add_argument("--device", default=DEVICE_MAC)
ap.add_argument("--cycles", type=int, default=10, help="recover: induced disconnects")
ap.add_argument("--recovery-timeout", type=int, default=90, help="recover: seconds to wait for recovery")
ap.add_argument("--induce", default="disconnect", choices=["disconnect", "manual"],
                help="recover: 'disconnect' asks the proxy to drop the link; 'manual' waits for you to power-cycle the reader")
ap.add_argument("--with-response", action="store_true",
                help="use write-with-response (Noble path). Default is without-response (Rust bridge path)")
ap.add_argument("--scan-seconds", type=float, default=10, help="time for the proxy to hear the device advertise")
ap.add_argument("--verbose", "-v", action="store_true")
args = ap.parse_args()

PROJECT_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = PROJECT_ROOT / "tmp" / "soak"
CMD_TIMEOUT_S = 5.0

logging.basicConfig(
    level=logging.DEBUG if args.verbose else logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("probe")
# The proxy libraries are chatty at INFO; keep them at WARNING unless -v.
for noisy in ("aioesphomeapi", "habluetooth", "bleak_esphome", "bleak"):
    logging.getLogger(noisy).setLevel(logging.DEBUG if args.verbose else logging.WARNING)

# ---------------------------------------------------------------- state

started = time.monotonic()
started_wall = time.time()

stats: dict = {
    "label": args.label,
    "mode": args.mode,
    "transport": "esphome-proxy",
    "proxy": args.proxy,
    "proxyInfo": None,
    "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(started_wall)),
    "durationMin": args.minutes,
    "intervalMs": args.interval,
    "writeWithResponse": args.with_response,
    "tagNotifications": 0,
    "bytesIn": 0,
    "streamGaps": 0,
    "bringupOk": None,
    "sent": 0,
    "responses": 0,
    "valid": 0,
    "timeouts": 0,
    "latencies": [],
    "bleConnects": 0,
    "bleDisconnects": 0,     # unexpected GATT disconnects reported by the proxy
    "apiWarnings": 0,        # WARNING+ records from aioesphomeapi / bleak_esphome
    "longestSilenceMs": 0,
    "mtu": None,
    "events": [],
}

elapsed_s = lambda: round(time.monotonic() - started)


def log_event(kind: str, detail: str = "") -> None:
    e = {"t": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()), "elapsedS": elapsed_s(), "type": kind, "detail": detail}
    stats["events"].append(e)
    print(f"  [{e['elapsedS']}s] {kind}{': ' + detail if detail else ''}", flush=True)


class WarningCounter(logging.Handler):
    """Count proxy-library warnings so a noisy API link shows up in the summary."""

    def emit(self, record: logging.LogRecord) -> None:
        if record.levelno >= logging.WARNING and record.name.split(".")[0] in ("aioesphomeapi", "bleak_esphome", "habluetooth"):
            stats["apiWarnings"] += 1
            stats["events"].append({"t": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()), "elapsedS": elapsed_s(),
                                    "type": "api_warning", "detail": f"{record.name}: {record.getMessage()}"[:300]})


logging.getLogger().addHandler(WarningCounter())

# ---------------------------------------------------------------- link

stopping = False
client: bleak.BleakClient | None = None
pending: dict | None = None          # {"sent_at": float, "fut": Future}
last_response_at = time.monotonic()
link_down_event = asyncio.Event()     # set by the disconnected callback
expected_disconnect = False


def on_notify(_char, data: bytearray) -> None:
    global pending, last_response_at
    d = bytes(data)
    last_response_at = time.monotonic()
    stats["bytesIn"] += len(d)

    if is_inventory_tag(d):
        stats["tagNotifications"] += 1
        return
    if args.mode == "thrash":
        if is_status_reply(d):
            stats["responses"] += 1
        return
    if is_valid_response(d):
        stats["responses"] += 1
        if pending and not pending["fut"].done():
            stats["valid"] += 1
            stats["latencies"].append(round((time.monotonic() - pending["sent_at"]) * 1000))
            pending["fut"].set_result(True)


def on_disconnected(_c: bleak.BleakClient) -> None:
    if not expected_disconnect:
        stats["bleDisconnects"] += 1
        log_event("ble_disconnect", "proxy reported GATT disconnect")
    link_down_event.set()


async def find_device(timeout_s: float):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline and not stopping:
        dev = await bleak.BleakScanner.find_device_by_address(args.device, timeout=2.0)
        if dev is not None:
            return dev
        await asyncio.sleep(0.5)
    return None


async def connect_link() -> bool:
    """Connect + subscribe through the proxy. Returns True when notifications are live."""
    global client
    dev = await find_device(30)
    if dev is None:
        log_event("device_not_heard", f"{args.device} not advertising to the proxy within 30s")
        return False
    link_down_event.clear()
    c = bleak.BleakClient(dev, disconnected_callback=on_disconnected, timeout=30.0)
    t0 = time.monotonic()
    await c.connect()
    await c.start_notify(NOTIFY_UUID, on_notify)
    client = c
    stats["bleConnects"] += 1
    stats["mtu"] = getattr(c, "mtu_size", None)
    log_event("ble_connected", f"in {(time.monotonic() - t0) * 1000:.0f} ms, mtu={stats['mtu']}")
    return True


async def drop_link() -> None:
    global client, expected_disconnect
    if client is None:
        return
    expected_disconnect = True
    try:
        await client.disconnect()
    except Exception as exc:  # noqa: BLE001 — teardown best-effort
        log.debug("disconnect raised: %s", exc)
    finally:
        expected_disconnect = False
        client = None


async def write(data: bytes) -> bool:
    if client is None or not client.is_connected:
        return False
    try:
        await client.write_gatt_char(WRITE_UUID, data, response=args.with_response)
        return True
    except Exception as exc:  # noqa: BLE001 — record and keep measuring
        log_event("write_error", str(exc)[:200])
        return False


# ---------------------------------------------------------------- modes

async def poll_once() -> None:
    global pending
    if pending is not None or client is None or not client.is_connected:
        return
    loop = asyncio.get_running_loop()
    pending = {"sent_at": time.monotonic(), "fut": loop.create_future()}
    stats["sent"] += 1
    if not await write(TEST_COMMAND):
        pending = None
        return
    try:
        await asyncio.wait_for(asyncio.shield(pending["fut"]), CMD_TIMEOUT_S)
    except asyncio.TimeoutError:
        stats["timeouts"] += 1
        log_event("cmd_timeout")
    finally:
        pending = None


async def poll_loop() -> None:
    while not stopping:
        asyncio.create_task(poll_once())
        await asyncio.sleep(args.interval / 1000)


async def thrash_loop() -> None:
    toggle = False
    while not stopping:
        toggle = not toggle
        if await write(TEST_COMMAND if toggle else BATTERY_COMMAND):
            stats["sent"] += 1
        await asyncio.sleep(args.interval / 1000)


async def start_inventory() -> None:
    log_event("inventory_bringup_start")
    for desc, data, delay in INVENTORY_BRINGUP:
        if not await write(data):
            stats["bringupOk"] = False
            log_event("inventory_bringup_failed", desc)
            return
        await asyncio.sleep(delay)
    stats["bringupOk"] = True
    log_event("inventory_bringup_done")


async def stop_inventory() -> None:
    await write(RFID_HST_CMD_ZERO)
    await write(RFID_ABORT)


async def await_healthy(timeout_s: float) -> bool:
    """Send a probe every second until a valid response arrives."""
    global pending
    deadline = time.monotonic() + timeout_s
    loop = asyncio.get_running_loop()
    while time.monotonic() < deadline and not stopping:
        if client is not None and client.is_connected:
            pending = {"sent_at": time.monotonic(), "fut": loop.create_future()}
            if await write(TEST_COMMAND):
                try:
                    await asyncio.wait_for(asyncio.shield(pending["fut"]), 1.0)
                    pending = None
                    return True
                except asyncio.TimeoutError:
                    pass
            pending = None
        else:
            await asyncio.sleep(1.0)
    return False


async def wait_for_link(timeout_s: float) -> bool:
    """Reconnect through the proxy until it sticks, or timeout."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline and not stopping:
        if client is not None and client.is_connected:
            return True
        try:
            if await connect_link():
                return True
        except Exception as exc:  # noqa: BLE001 — keep trying until deadline
            log_event("reconnect_error", str(exc)[:200])
            await asyncio.sleep(1.0)
    return False


async def recovery_cycles() -> None:
    """
    Induce a real GATT drop and measure whether — and how fast — the link comes back.

    'disconnect' asks the proxy to drop the link (BLUETOOTH_DEVICE_REQUEST_TYPE_DISCONNECT);
    the reader stays powered and advertising, so this mirrors `hcitool ledc` in ble-soak.js.
    'manual' waits for the link to fall over on its own — power-cycle the reader when prompted.
    """
    stats["cycles"] = []
    log_event("recovery_test_start", f"{args.cycles} cycles, induce={args.induce}")

    if not await await_healthy(60):
        log_event("recovery_abort", "never became healthy at start")
        return
    log_event("baseline_healthy")

    for i in range(1, args.cycles + 1):
        if stopping:
            break
        if not await wait_for_link(45):
            log_event("cycle_skip", f"#{i}: link never re-established within 45s")
            stats["cycles"].append({"cycle": i, "induced": False, "recovered": False})
            continue
        await asyncio.sleep(2.0)

        warnings_before = stats["apiWarnings"]
        if args.induce == "disconnect":
            log_event("inducing_disconnect", f"#{i} via proxy disconnect request")
            await drop_link()
        else:
            print(f"\n  >>> cycle #{i}: POWER-CYCLE THE READER NOW (waiting up to 120s for the drop)\n", flush=True)
            try:
                await asyncio.wait_for(link_down_event.wait(), 120)
            except asyncio.TimeoutError:
                log_event("cycle_skip", f"#{i}: no drop observed")
                stats["cycles"].append({"cycle": i, "induced": False, "recovered": False})
                continue
            await drop_link()

        t0 = time.monotonic()
        relinked = await wait_for_link(args.recovery_timeout)
        recovered = await await_healthy(20) if relinked else False
        ms = round((time.monotonic() - t0) * 1000)
        rec = {
            "cycle": i, "induced": True, "dropConfirmed": True, "recovered": recovered,
            "recoveryMs": ms if recovered else None, "apiWarnings": stats["apiWarnings"] - warnings_before,
        }
        stats["cycles"].append(rec)
        log_event("recovered" if recovered else "RECOVERY_FAILED", f"#{i} in {ms / 1000:.1f}s, apiWarnings={rec['apiWarnings']}")


async def monitor() -> None:
    in_gap = False
    while not stopping:
        silence_ms = (time.monotonic() - last_response_at) * 1000
        stats["longestSilenceMs"] = max(stats["longestSilenceMs"], silence_ms)
        if args.mode == "inventory" and stats["bringupOk"]:
            if silence_ms > 2000 and not in_gap:
                in_gap = True
                stats["streamGaps"] += 1
                log_event("stream_gap", f"{silence_ms / 1000:.0f}s of silence")
            elif silence_ms <= 2000:
                in_gap = False
        # Outside recover mode, a dropped link is a defect: reconnect and count it.
        if args.mode != "recover" and link_down_event.is_set() and not stopping:
            link_down_event.clear()
            if await wait_for_link(args.recovery_timeout):
                log_event("link_restored")
                if args.mode == "inventory":
                    await start_inventory()
        await asyncio.sleep(2.0)


async def progress() -> None:
    while not stopping:
        await asyncio.sleep(30)
        el = max(1, elapsed_s())
        remain = max(0, round(args.minutes * 60 - el))
        if args.mode == "inventory":
            load = f"tags={stats['tagNotifications']} ({stats['tagNotifications'] / el:.1f}/s) gaps={stats['streamGaps']}"
        elif args.mode == "recover":
            load = f"cycles={len(stats.get('cycles', []))}/{args.cycles}"
        elif args.mode == "thrash":
            load = f"writes={stats['sent']} ({stats['sent'] / el:.0f}/s) replies={stats['responses']}"
        else:
            load = f"sent={stats['sent']} ok={stats['valid']} timeout={stats['timeouts']}"
        link = "UP" if client is not None and client.is_connected else "DOWN"
        print(f"  … {el}s elapsed, {remain}s left | {load} link={link}", flush=True)


# ---------------------------------------------------------------- report

def percentile(arr: list[int], p: int):
    if not arr:
        return None
    s = sorted(arr)
    return s[min(len(s) - 1, int(p / 100 * len(s)))]


def report() -> None:
    dur = max(1, elapsed_s())
    stats["endedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
    stats["actualDurationS"] = dur
    cycles = stats.get("cycles", [])
    if args.mode == "inventory":
        body = {"bringupOk": stats["bringupOk"], "tagNotifications": stats["tagNotifications"],
                "tagsPerSec": round(stats["tagNotifications"] / dur, 1), "kbIn": round(stats["bytesIn"] / 1024, 1),
                "streamGaps": stats["streamGaps"]}
    elif args.mode == "recover":
        rec_ms = [c["recoveryMs"] for c in cycles if c.get("recoveryMs")]
        body = {"cyclesRequested": args.cycles, "cyclesRun": sum(1 for c in cycles if c["induced"]),
                "dropsConfirmed": sum(1 for c in cycles if c.get("dropConfirmed")),
                "recovered": sum(1 for c in cycles if c["recovered"]),
                "failed": sum(1 for c in cycles if c["induced"] and not c["recovered"]),
                "recoveryMs": {"p50": percentile(rec_ms, 50), "max": max(rec_ms) if rec_ms else None}}
    elif args.mode == "thrash":
        body = {"sent": stats["sent"], "writesPerSec": round(stats["sent"] / dur, 1), "responses": stats["responses"],
                "replyRatio": round(100 * stats["responses"] / stats["sent"], 1) if stats["sent"] else 0,
                "kbIn": round(stats["bytesIn"] / 1024, 1)}
    else:
        body = {"sent": stats["sent"], "valid": stats["valid"], "timeouts": stats["timeouts"],
                "successRate": round(100 * stats["valid"] / stats["sent"], 2) if stats["sent"] else 0,
                "latencyMs": {"p50": percentile(stats["latencies"], 50), "p95": percentile(stats["latencies"], 95),
                              "max": max(stats["latencies"]) if stats["latencies"] else None}}

    stats["summary"] = {
        "label": args.label, "mode": args.mode, "transport": "esphome-proxy", "durationS": dur, **body,
        # Same column names as ble-soak.js so the JSONs diff cleanly; panics/pm2 don't exist here.
        "panics": 0, "pm2Restarts": 0, "wsCloses": 0,
        "linkDrops": stats["bleDisconnects"], "apiWarnings": stats["apiWarnings"],
        "longestSilenceS": round(stats["longestSilenceMs"] / 1000),
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{args.label}.json"
    out.write_text(json.dumps(stats, indent=2))
    print("\n" + "=" * 64)
    print(f"PROBE RESULT — {args.label}")
    print("=" * 64)
    for k, v in stats["summary"].items():
        print(f"  {k:<18} {json.dumps(v) if isinstance(v, (dict, list)) else v}")
    print(f"\n  written to {out}")


# ---------------------------------------------------------------- main

async def main() -> int:
    global stopping
    host, _, port = args.proxy.partition(":")
    cfg: ESPHomeDeviceConfig = {"address": host if not port else args.proxy, "noise_psk": args.psk}
    conn = APIConnectionManager(cfg)

    print(f"\n🔬 ESPHome proxy probe: {args.label} — mode={args.mode}, {args.minutes} min @ {args.interval} ms")
    print(f"   proxy:  {args.proxy}")
    print(f"   device: {args.device}  write={'with' if args.with_response else 'without'}-response\n")

    await habluetooth.BluetoothManager().async_setup()
    try:
        start = asyncio.create_task(conn.start())
        done, pend = await asyncio.wait({start}, timeout=10)
        if pend:
            start.cancel()
            await asyncio.gather(start, return_exceptions=True)
            log_event("proxy_unreachable", f"{args.proxy} did not answer on the native API within 10s")
            report()
            return 2
        start.result()
        try:
            info = await conn._cli.device_info()  # noqa: SLF001 — probe-only introspection
            stats["proxyInfo"] = {"name": info.name, "esphome": info.esphome_version, "model": info.model,
                                  "mac": info.mac_address, "btProxyFeatures": info.bluetooth_proxy_feature_flags}
            log_event("proxy_connected", f"{info.name} ESPHome {info.esphome_version} ({info.model}) features=0x{info.bluetooth_proxy_feature_flags:x}")
        except Exception as exc:  # noqa: BLE001
            log_event("proxy_connected", f"(device_info unavailable: {exc})")

        await asyncio.sleep(args.scan_seconds)
        if not await wait_for_link(60):
            log_event("abort", "could not establish GATT link through the proxy")
            report()
            return 3

        tasks = [asyncio.create_task(monitor()), asyncio.create_task(progress())]
        if args.mode == "poll":
            tasks.append(asyncio.create_task(poll_loop()))
        elif args.mode == "thrash":
            tasks.append(asyncio.create_task(thrash_loop()))
        elif args.mode == "inventory":
            await start_inventory()
        elif args.mode == "recover":
            tasks.append(asyncio.create_task(recovery_cycles()))

        deadline = args.minutes * 60
        try:
            if args.mode == "recover":
                await asyncio.wait_for(tasks[-1], timeout=deadline if deadline > 0 else None)
            else:
                await asyncio.sleep(deadline)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass
        finally:
            stopping = True
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if args.mode == "inventory":
                await stop_inventory()
                await asyncio.sleep(0.8)
            await drop_link()
    finally:
        await conn.stop()
        report()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        stopping = True
        report()
