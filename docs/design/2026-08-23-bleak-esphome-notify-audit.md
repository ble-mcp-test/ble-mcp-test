# `bleak-esphome` notify path — source audit

**Status:** FINDING / resolves Open Question 1 of `2026-08-23-python-bridge-rewrite.md`, which said
*"do not treat the choice as settled until this is read."*

**Verdict: the notify path does NOT upset the decision. It is better than what we have.**

**Method.** `pip download --no-deps` of `bleak-esphome 4.0.0` and `aioesphomeapi 45.13.1` (the exact
versions cited in the ADR), wheels unzipped and read. Nothing installed, no environment touched, no
code executed. Line references are to the extracted wheel contents.

---

## The path, traced end to end

```
BluetoothGATTNotifyDataResponse
  → APIConnection data_received                      (aioesphomeapi/connection.py)
  → self._message_handlers[type(msg)]                 dict lookup by message type
  → on_bluetooth_gatt_notify_data_response(...)       (client_base.py:165) partial-bound address+handle
  → if address == msg.address and handle == msg.handle   ← THE FILTER
  → on_bluetooth_gatt_notify(handle, bytearray(msg.data))
  → lambda handle, data: callback(data)               (bleak_esphome/backend/client.py:902)
  → bleak's NotifyCallback(bytearray)
```

Registration is `add_message_callback(partial(on_bluetooth_gatt_notify_data_response, address,
handle, cb), (BluetoothGATTNotifyDataResponse,))` at `client.py:1343-1351`, with the cancel token
stored under `key = (address, handle)` at `:1365-1366`.

---

## Answers to the five questions

### 1. Correlation — **per-(address, handle), explicit. This was the real worry and it is clean.**

`client_base.py:172`:

```python
if address == msg.address and handle == msg.handle:
    on_bluetooth_gatt_notify(handle, bytearray(msg.data))
```

Every notification is checked against **both** the address and the handle the callback was
registered for. The registry is keyed on the tuple `(address, handle)`
(`client.py:1365`, `:1383`).

**TRA-1154's failure class does not exist one layer down.** That defect is "settles the pending
command with whatever command-class packet arrives"; this is the opposite — a notification for the
wrong device or the wrong handle is silently ignored rather than delivered to the wrong consumer.
Adopting this library *removes* the correlation hazard rather than reproducing it, which is the
inverse of what `@2colors/esphome-native-api` would have done.

Also: a second `start_notify` on a handle that already has one raises `BleakError` explicitly
(`bleak_esphome/backend/client.py:883-889`) rather than silently double-subscribing.

### 2. Queueing and slow consumers — **no queue; backpressure, not growth**

Dispatch is **synchronous and direct** from the protocol's `data_received`
(`connection.py:1175-1210`). There is no intermediate queue, no buffer, and therefore nothing
unbounded.

Consequence for a slow consumer: it **blocks the event loop**, and TCP backpressure propagates to
the proxy. It does **not** silently drop and it does **not** grow without limit. For our workload
that is the safe failure mode — a stall is visible, whereas silent drops would be the
failure-becomes-silence class again.

Note the design implication: our notify callback runs **on the event loop, synchronously**. Anything
slow in it stalls the whole connection. The bridge must hand off to a queue of its own if it does
non-trivial work per notification.

### 3. Per-notification cost — **low; measure rather than trust this**

Per notification: one dict lookup by message type; a `set.copy()` **only** when more than one
handler is registered for that type (the single-handler path skips the copy, with an explicit
comment that Cython optimizes `next(iter(handlers))` poorly); one `partial` invocation; two integer
comparisons; one `bytearray(msg.data)` **copy**; one lambda hop.

So one allocation per notification (the `bytearray`), and no parsing beyond protobuf decode. The
wheels are Cython-compiled (`cp312` manylinux, not pure Python).

At our ~45 msg/s this is comfortably irrelevant. **[inferred]** it should survive 10-100×, but that
is reasoning, not measurement — and the firehose stress test is sequenced first precisely so this
gets settled by data instead. Do not treat this paragraph as clearance.

### 4. `stop_notify` teardown — **clean, and stale subscriptions are structurally prevented**

`stop_notify` (`bleak_esphome/backend/client.py:945-966`) pops from `_notify_cancels` and awaits
`notify_stop()`. If nothing is subscribed it returns silently, matching the BlueZ backend, so callers
need not track their own subscriptions.

On disconnect, `_async_disconnected_cleanup` (`:186-195`) iterates every entry in `_notify_cancels`,
calls `notify_abort()` on each, and clears the dict.

The stronger guarantee is structural: `add_message_callback` registers into `_message_handlers`,
which **lives on the connection object**. When the connection dies the handler registry dies with
it. A subscription therefore *cannot* outlive its connection.

**This is 3f7eefb's bug class — "stale disconnect event from a dead transport processed as current"
— structurally prevented rather than defended against.** The salvaged knuckles patch had to add
`currentTransportId` tracking to filter stale events; here there is nothing stale to filter, because
the registry has the same lifetime as the transport.

### 5. Exception handling — **caught and logged, not swallowed** (bears on Hazard 2)

`connection.py:1184-1192` wraps every handler call in `try/except`, logging via
`_LOGGER.exception` with an explicit comment: *"Isolate user-callback exceptions so a buggy handler
does not propagate through asyncio's data_received path and tear the whole session down. See issue
#1755."*

Better than the asyncio default the ADR warns about — a raising callback is logged rather than
vanishing at GC time. **But note the consequence for our design: exceptions in our notify callback
will NOT propagate.** The bridge must not rely on them escaping; errors have to be surfaced
deliberately from inside the callback.

---

## Consequences for the ADR

1. **Open Question 1 is resolved.** The notify path is sound. The decision stands, and this removes
   the one finding flagged as able to upset it.
2. **Two of the project's recurring bug classes are handled better here than in our current code** —
   `(address, handle)` correlation (TRA-1154) and stale-subscription lifetime (3f7eefb). That is an
   additional argument for Python, not merely an absence of objection.
3. **One new design constraint:** the notify callback runs synchronously on the event loop.
   Non-trivial per-notification work belongs behind the bridge's own queue. This should be a stated
   requirement in the WS-relay ticket.
4. **Hazard 2 is narrowed but not removed.** `aioesphomeapi` isolates handler exceptions; our own
   tasks still need the every-task-awaited-or-done-callback rule.

## What was NOT determined

- Real throughput ceiling. Not measured; the firehose test settles it.
- Behaviour under a genuinely slow consumer at rate — reasoned from the synchronous dispatch, not
  observed.
- Whether the CCCD-write path on v3/`REMOTE_CACHING` connections
  (`bleak_esphome/backend/client.py:908-941`) has failure modes worth caring about. Read but not
  analysed; it is on the subscribe path, not the per-notification path, so it does not affect the
  throughput question.
