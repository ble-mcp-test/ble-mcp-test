# Firehose baseline — bridge relay throughput and latency

**Status: RECORDED, 2026-08-23.** Zero message loss at 10×, 20×, 50× and 100× the production
notification rate, no heap growth, and per-notification latency that rises sublinearly with rate.

This settles the one unmeasured claim in `2026-08-23-bleak-esphome-notify-audit.md` §3 — that
per-notification cost should survive 10–100× — which was marked `[inferred]` and explicitly not
clearance. **For the TypeScript relay it survives, measured.**

Reproduce with:

```bash
FIREHOSE_BASELINE=1 FIREHOSE_SECONDS=60 FIREHOSE_LABEL=ts-bridge-mssb pnpm run stress:firehose
```

---

## Results

> **These figures measure the RELAY, not the bridge as deployed.** Notifications are injected at the
> transport, so no radio, no ESPHome proxy, no protobuf decode and no RF is in the path. "The relay
> sustains 4500 msg/s on this host with this consumer" is supported; "the bridge handles 4500 msg/s"
> is not.

`tmp/firehose/ts-bridge-mssb.json`, 60 s per rate, 487,994 notifications total. Latency in
milliseconds; heap is the median of the last quarter of samples minus the median of the first.

| target msg/s | ×prod | achieved | injected | received | lost | missing | p50 | p90 | p99 | p99.9 | max | heap Δ MB | peak RSS MB | sat ticks |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 450 | 10× | 450.0 | 27,000 | 27,000 | **0** | 0 | 0.010 | 0.029 | 0.140 | 0.401 | 0.712 | −0.23 | 73.4 | 0 |
| 900 | 20× | 900.0 | 53,999 | 53,999 | **0** | 0 | 0.009 | 0.014 | 0.064 | 0.192 | 0.695 | +0.14 | 64.5 | 0 |
| 2250 | 50× | 2250.0 | 134,997 | 134,997 | **0** | 0 | 0.013 | 0.028 | 0.081 | 0.209 | 2.461 | +0.02 | 66.1 | 0 |
| 4500 | 100× | 4499.9 | 269,998 | 269,998 | **0** | 0 | 0.020 | 0.037 | 0.092 | 0.224 | 1.298 | −0.50 | 70.5 | 0 |

Latency sample counts after warmup: 26,550 / 53,099 / 132,749 / 265,500, none overflowed. Memory
samples: 241 per rate.

### What the numbers say

- **No loss anywhere.** `lost` and `missing` agree at zero on every row, so nothing was dropped and
  nothing was reordered.
- **Per-notification cost is sublinear in rate.** p50 goes 0.010 → 0.020 ms across a tenfold rate
  increase. Cost per notification roughly doubles while throughput rises 10×.
- **The tail is flat, not growing.** p99 sits between 0.064 and 0.140 ms with no upward trend against
  rate; the highest p99 is at the *lowest* rate, which is scheduler granularity showing through when
  there is less work per tick, not queueing.
- **No unbounded memory growth.** Heap deltas scatter across −0.50 to +0.14 MB over 60 s windows —
  noise around zero, with no relationship to rate — and peak RSS stays in a 64–73 MB band.
- **Zero saturated ticks throughout, which is what licenses all of the above.** The generator never
  hit its per-tick cap, so these figures bound the bridge rather than the instrument. A row with
  non-zero saturated ticks would have measured the harness.

The `max` column (0.7–2.5 ms) is single-sample GC and scheduler noise. It is reported because
suppressing it would be dishonest, not because it characterises anything.

## What is measured

One notification's journey, end to end:

```
FirehoseTransport 'data'        synthetic notification, seq + injection timestamp in the payload
  → BleSession                  re-emits on the session
  → WebSocketHandler            ws-handler.ts:82-88
  → Array.from(Uint8Array)      per-notification allocation
  → JSON.stringify              per-notification serialisation
  → ws                          real WebSocket, loopback
  → JSON.parse                  consumer side
  → Uint8Array.from             consumer side
  → decode seq + timestamp      latency = now - injected
```

**Consumer-side deserialisation is inside the measurement, deliberately.** It is what
`ws-transport.ts` does before handing bytes to the mock, so excluding it would measure something no
consumer actually experiences. The consequence is a constraint on any future comparison: **a Python
bridge is only comparable against this baseline if it is measured with this same harness and this
same consumer.** Swapping the consumer changes the number without changing the bridge.

## What is NOT measured

The injection point *is* the transport, so nothing upstream of `BleSession` is exercised:

- no BLE radio, no BlueZ, no Noble
- no ESPHome proxy, no protobuf decode, no TCP to the proxy
- no real device, no RF, no tag field

This baseline bounds **the relay**, not the whole stack. "The bridge handles 4500 msg/s" is not a
claim this experiment supports; "the relay does, on this host, with this consumer" is. A Python
bridge that matches these figures has matched the relay; the transport below it is TRA-1158's
problem and needs hardware.

That is the correct scope for TRA-1156 — the ticket asks for a field-free, hardware-free load
generator precisely so the relay can be characterised while the reader is contended — but the
boundary has to be stated or the number will be quoted for more than it covers.

## Method

| | |
|---|---|
| Injection | `FirehoseTransport`, absolute (drift-free) scheduler, 1 ms tick |
| Payload | 20 bytes: `seq` uint32 LE, injection timestamp float64 LE, `0xA7` filler |
| Rates | 450 / 900 / 2250 / 4500 msg/s — 10× / 20× / 50× / 100× the ~45 msg/s production rate |
| Duration | 60 s per rate |
| Warmup | first 10% of each run, capped at 1 s, excluded from latency stats |
| Drain | 500 ms after generation stops, so in-flight notifications are not counted as loss |
| Loss | `injected - received`, cross-checked against sequence-number gap sizes |
| Latency | preallocated `Float64Array`, exact nearest-rank percentiles — no reservoir sampling |
| Memory | `heapUsed` sampled every 250 ms; median of the last quarter minus median of the first |
| Bind | OS-assigned ephemeral port on `127.0.0.1`; the run aborts if it is ever handed 8080 |

Generator and consumer share one Node process, so `performance.now()` is directly comparable at both
ends. That is what makes sub-millisecond latency meaningful here; a cross-process measurement would
be dominated by clock skew.

## Preconditions, recorded at run time

Captured immediately before the ladder started, because a throughput number without the state of the
machine under it is not reproducible:

```
host            mssb (incus container)
kernel          6.8.0-138-generic
cpus            24
cgroup cpu.max  max 100000      (no quota)
cgroup mem.max  max             (no limit)
memory          96.4 GB total, 93.9 GB available
node            v24.13.0
started         2026-08-23T19:42:18Z
load average    0.06 / 0.33 / 0.36
established connections on :8080   0
```

**The box was deliberately quiet.** A peer agent (TRA-1167) was running a timing-sensitive hardware
soak on the same 24 cores that evening and halted it for this window; a latency baseline recorded
under someone else's load would be a number with a story attached, not a baseline. Anyone re-running
this for comparison must reproduce that condition, not just the software configuration.

**And note the limit of that.** Every precondition above is one the software could see. The same
evening, five hardware reps on this bench were voided because a test tag was physically occluded by
the tag stack — a fact no instrument in the system could have recorded. Preconditions include the
ones nothing in the process can observe; those get captured by hand or they are not captured at all.

## The instrument was verified in both directions

Every functional assertion in this harness is of the form "zero loss", and **a harness that cannot
detect loss at all passes every one of them.** So the loss path is exercised deliberately:
`runFirehose({ dropEveryNth: 10 })` discards one in ten notifications in the consumer, and the test
asserts the accounting reports them. It does. The same harness reports zero when nothing is dropped.

Execution proves the check ran. Breaking the subject proves the check works. Both were done before
any number above was believed.

## Reading a future run

- **`lost`** — the headline. Non-zero at any rate means the relay dropped notifications.
- **`missing`** — sum of sequence-gap sizes. Should agree with `lost`; disagreement means
  reordering, not loss.
- **`saturatedTicks`** — **non-zero invalidates that row as a statement about the bridge.** It means
  the generator hit its per-tick cap, so the measured ceiling is the instrument's, not the subject's.
- **`achievedRatePerSec`** — if this falls short of target with `saturatedTicks` at zero, the
  generator was starved by the host rather than by its own cap. Treat the row as contended.
- **`growthMB`** — heap growth across the run. Some scatter is normal; a figure that scales with
  duration is the unbounded case the acceptance criterion is about.
