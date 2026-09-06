# ESPHome Bluetooth Proxy probe

Flash an ESP32 as a Bluetooth Proxy, then measure what it does under this
project's four traffic shapes: steady polling, induced disconnects, a live tag
stream, and back-to-back writes.

The proxy is the bridge's only route to the device — there is no local radio —
so its behaviour under load is the bridge's behaviour under load. Re-measure
after anything that could change it: new ESPHome firmware, a different board, a
move to another network segment, or a hardware fault you are trying to pin down.

The probe talks the ESPHome native API over TCP via `bleak-esphome`, the same
library the bridge uses. No Home Assistant. It writes a summary JSON to
`tmp/soak/<label>.json` in the same column layout as `scripts/ble-soak.js`, so
runs from either tool sit side by side.

## 1. Flash the proxy

**The reference board is the Waveshare ESP32-S3-ETH with PoE.** USB-C flashing with
no serial wiring, a W5500 on SPI so WiFi stays off the BLE radio, and an
external-antenna variant. It is what `bridge/tests/hardware/` has been measured
against.

```bash
uvx esphome run scripts/esphome-probe/waveshare-esp32-s3-eth.yaml
```

Every config here pins `min_version: 2026.5.1` — the release with the connection-slot
leak fix. Don't go older.

**Flashing more than one board: change `esphome.name` first.** The config hardcodes
`waveshare-s3-eth-probe`, and that name is the mDNS hostname. Flash two boards from
it unedited and both answer to `waveshare-s3-eth-probe.local`; whichever replies
first wins, and it need not be the same one twice. That presents as a proxy that
intermittently has the wrong uptime, the wrong heap, or no link to the reader —
none of which looks like a naming problem. Give each board its own `name:` (and
`friendly_name:`) before `esphome run`, and confirm with `ping` that the host you
reach is the one you just flashed.

Ethernet first, BLE second. A proxy on a lossy link produces `apiWarnings` and slow
recoveries that read as BLE problems, so spend two minutes ruling it out **before**
any BLE test:

```bash
ping -c 300 -i 0.2 waveshare-s3-eth-probe.local     # want 0 % loss, single-digit ms
```

Anything above ~0.5 % loss is an ethernet problem and will contaminate every number
below it.

Keep a log tail open during runs; the two proxy-side symptoms the client can't see
are `Failed to send notify data response` (notify data dropped, TCP buffer full) and
`... deferred, TCP buffer full`:

```bash
uvx esphome logs scripts/esphome-probe/waveshare-esp32-s3-eth.yaml
```

### The other two configs

- **`esp32-devkit.yaml`** — any generic ESP32 dev kit, over WiFi. Worth flashing to
  measure what WiFi/BLE radio contention costs against a wired proxy; expect it to
  be worse, which is the point of measuring it. Needs
  `cp secrets.example.yaml secrets.yaml` with your WiFi filled in.
- **`gl-s10.yaml`** — the GL.iNet GL-S10, evaluated and **not** adopted: the fleet
  on hand is v2.1 (IP101 PHY) and did not hold up for this use case. Kept because
  the config works and the board is a reasonable second data point, not because it
  is a recommendation. Flashing one needs serial on an internal header, so the case
  has to come off; the file's own header carries the revision detail and the
  LAN8720 variant block.

## 2. Run the probe

`uv` resolves the Python deps from the script header on first run.

```bash
P=waveshare-s3-eth-probe.local      # or the IP

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
link. `--induce manual` instead waits for you to power-cycle the reader each cycle —
a harsher, more realistic drop, and the only one that exercises the reader's own
re-advertisement.

Writes default to **without-response**, which is what the bridge does.
`--with-response` flips to write-with-response.

## 3. Read the result

Each run prints a summary and writes `tmp/soak/<label>.json`. Columns match
`ble-soak.js`; `panics`/`bridgeRestarts` are `null` here — there is no subprocess to
panic and no bridge process to watch, and `null` means *not observed* rather than
*none happened*. Two columns are specific to this tool:

- `linkDrops` — unexpected GATT disconnects reported by the proxy
- `apiWarnings` — WARNING+ records from `aioesphomeapi`/`bleak_esphome` (API link
  noise: reconnects, timeouts, slot waits)

A healthy proxy: **`recover` 10/10**, `poll` success ≥ 99.9 %, and `streamGaps: 0`
on the inventory run. Latency is the number to compare against your own previous
run rather than against a fixed threshold — it moves with the network path, and a
p50 that has doubled since the last firmware is a finding even when it is still
comfortably inside the bridge's budget.

Keep the JSON. A single run tells you whether the proxy is broken right now; two
runs either side of a change tell you what the change did, which is the question
that usually brought you here.
