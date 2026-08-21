# ESPHome Bluetooth Proxy probe

Answers one question empirically: **can an ESPHome Bluetooth Proxy (GL-S10 or any
ESP32) replace the local BlueZ/btleplug radio as the transport under ble-mcp-test?**

It is the Python twin of `scripts/ble-soak.js` — same CS108 commands, same four
modes, same summary JSON written to `tmp/soak/<label>.json` — so the results line up
column-for-column with the adapter evaluation in `STATE-OF-PLAY.md` §11.

No Home Assistant, no BlueZ, no local radio. The probe talks the ESPHome native API
over TCP via `bleak-esphome`, which is the same path a Rust bridge would take with
the `esphome-native-api` crate.

## Baselines to beat (ASUS dongle + btleplug, 2026-08-21)

| Mode | Result |
|---|---|
| `poll` @ 1 s | 100 % (928/929 over 15 min; 72 min clean), p50 **40 ms**, p95 ~55 ms |
| `recover` ×10 | **10/10** recovered, p50 **5.5 s**, max 7.3 s |
| `inventory` | ~15–20 tags/s, ~23 B each (from production logs; not soaked locally) |

## 1. Flash the proxy

Check the GL-S10 hardware revision first. **v1.0 (LAN8720)** is the one people report
as solid; **v2.1+ (IP101)** has packet-loss reports. `gl-s10.yaml` defaults to v2.1+;
the LAN8720 block is at the bottom of the file. Nothing on the outside of the unit
or box identifies the revision — you have to open it, which flashing requires anyway
(serial is on a 9-hole header inside; the USB port is power only):

1. Pry the back off with a small flat screwdriver at the tab; the board slides out.
2. Read the silkscreen — `GL-S10 V1.0` / `V2.1` / `V2.3`.
3. Or read the Ethernet PHY chip next to the RJ45: **`LAN8720A`** (Microchip/SMSC)
   = v1.0; **`IP101GRI`** (IC Plus) = v2.x.
4. Definitive, once serial is wired: GL.iNet burns the revision into eFuse BLOCK3
   at bit 176 (byte 22). `uvx --from esptool espefuse.py --port /dev/ttyUSB0 summary`
   and read BLOCK3 — `0x00` = v1.0 LAN8720, `0x02` = v2.1+ IP101.

**Mike's unit is `GL-S10 V2.1` (board date 2022-05-06) → IP101, use the default block.**

About the v2.1 packet-loss reports: the root cause (GL.iNet, bluetooth-proxies #79)
was clocking the IP101 from the ESP32's *internal* clock. The fix is to take the
RMII clock *in* from the board's external crystal on GPIO0 — `clk: {pin: GPIO0,
mode: CLK_EXT_IN}` — which is what the official config and `gl-s10.yaml` do. Reports
go quiet after that fix landed (Aug 2023), so treat residual loss as unmeasured, not
as known-bad. Settle it in two minutes **before** any BLE test:

```bash
ping -c 300 -i 0.2 gl-s10-probe.local      # want 0 % loss, single-digit ms
```

Anything above ~0.5 % loss here will show up later as `apiWarnings` and slow
recoveries, and it's an ethernet problem, not a BLE one.

```bash
# GL-S10 — serial the first time (hold the button while applying power; never USB + PoE together)
uvx esphome run scripts/esphome-probe/gl-s10.yaml

# any ESP32 dev kit over WiFi (fallback / contention comparison)
cp scripts/esphome-probe/secrets.example.yaml scripts/esphome-probe/secrets.yaml  # fill in WiFi
uvx esphome run scripts/esphome-probe/esp32-devkit.yaml
```

Both configs pin `min_version: 2026.5.1` — the release with the connection-slot leak
fix. Don't go older.

Keep a log tail open during runs; the two proxy-side symptoms the client can't see
are `Failed to send notify data response` (notify data dropped, TCP buffer full) and
`... deferred, TCP buffer full`:

```bash
uvx esphome logs scripts/esphome-probe/gl-s10.yaml
```

## 2. Run the probe

`uv` resolves the Python deps from the script header on first run.

```bash
P=gl-s10-probe.local      # or the IP

# steady state — 15 min, 1 req/s
uv run scripts/esphome-probe/probe.py --proxy $P --mode poll --minutes 15 --label esphome-poll

# the test that actually discriminates: 10 induced disconnects
uv run scripts/esphome-probe/probe.py --proxy $P --mode recover --cycles 10 --label esphome-recover

# notify path under the real tag stream (8–10 tags in the field)
uv run scripts/esphome-probe/probe.py --proxy $P --mode inventory --minutes 10 --label esphome-inv

# write path, no waiting (matches ble-soak thrash @20 ms)
uv run scripts/esphome-probe/probe.py --proxy $P --mode thrash --interval 20 --minutes 5 --label esphome-thrash
```

`recover` defaults to `--induce disconnect`, which asks the proxy to drop the GATT
link (the proxy-side equivalent of `hcitool ledc`). `--induce manual` instead waits
for you to power-cycle the reader each cycle — a harsher, more realistic drop.

Writes default to **without-response** (what the Rust bridge does). `--with-response`
flips to the Noble path.

## 3. Read the result

Each run prints a summary and writes `tmp/soak/<label>.json`. Columns match
`ble-soak.js`; `panics`/`pm2Restarts` are always 0 here (there is no subprocess), and
two new ones appear:

- `linkDrops` — unexpected GATT disconnects reported by the proxy
- `apiWarnings` — WARNING+ records from `aioesphomeapi`/`bleak_esphome` (API link
  noise: reconnects, timeouts, slot waits)

Pass/fail is simple: **recover must be 10/10**, poll success ≥ 99.9 %, and the
inventory stream must show `streamGaps: 0`. Latency can be a bit worse than 40 ms
p50 (extra TCP hop) without changing the verdict.

## If it passes

The Rust bridge gets a `BleTransport` trait with two backends — `btleplug` (proven,
default) and `esphome` (`esphome-native-api` crate, all Bluetooth messages present
as of 3.0.0). The bridge then no longer needs a radio host at all: no BlueZ, no
D-Bus, no `bluez-async` panic, no adapter roulette, and it can run in a container.

## If it fails

Close TRA-1113 on evidence and attach the JSON. An hour well spent either way.
