# Python WS Relay (TRA-1157) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Python WebSocket relay — `connected` + `data` in both directions, the nine URL query parameters, and a loopback bind default — driven end to end by an injecting stub transport with no BLE hardware anywhere in the path.

**Architecture:** A `bridge/` uv package with one load-bearing `protocol.py` that owns every wire message name, a `BleTransport` seam mirroring `src/ble-transport.ts` so TRA-1158 can drop a real ESPHome transport in unchanged, and a `websockets` server that relays between them. Notifications hand off to an `asyncio.Queue` drained by a single sender task, which is both the notify audit's synchronous-callback rule and what preserves notification ordering under the firehose.

**Tech Stack:** Python 3.12, `uv`, `websockets`, `pytest` + `pytest-asyncio`, `ruff`. `just` as the cross-language front door delegating to `pnpm` and `uv`.

**Spec:** `docs/design/2026-08-23-ws-protocol-spec.md` (the acceptance criterion), with
`docs/design/2026-08-23-python-package-layout.md` for layout and
`docs/design/2026-08-23-firehose-baseline.md` for the harness method.

## Global Constraints

- **Bind default is `127.0.0.1`.** `127.0.0.1:8080` must be the resolved bind when nothing is configured; the test asserts loopback. `rust-ble-test/src/config.rs:70` defaults `ws_host` to `"0.0.0.0"` and `:163` asserts `"0.0.0.0:8080"` — that is the defect being retired, not a precedent.
- **`_mv` is telemetry only.** Absent → warn; mismatched → warn. No message to the client, nothing rejected, no behaviour change. Never a negotiation.
- **`protocol.py` owns every message-type string.** No message-type string literal appears anywhere else in the tree, tests included. Enforced mechanically by a test, not by eye (CLAUDE.md failure class 1).
- **No silent fallbacks.** A value that is present but unparseable is a loud failure, never a quiet default (CLAUDE.md failure class 2).
- **Exact error text:** `Missing required parameters: service, write, notify` — verbatim from `src/bridge-server.ts:84`.
- **`data` payload is a JSON array of ints**, not base64 — `Array.from(data)` at `src/ws-handler.ts:85-88`. This settles Open item 1 of the spec.
- **`connected` shape:** `{"type": "connected", "device": <str>}` — `src/bridge-server.ts:145`.
- **Do not implement:** `cleanup_session`, `session_cleanup_complete`, `admin_cleanup`, `admin_cleanup_complete`, `cleanup_complete`, `ack`, `disconnected`, `characteristicvaluechanged`, `eviction_warning`, `keepalive_ack`, `scan_result`, `notification`. Spec §5.
- **Out of scope, deliberately:** `error`/`warning` beyond parameter validation, `force_cleanup`, and single-writer/multi-observer ownership are TRA-1159. The real ESPHome transport is TRA-1158.
- **pnpm stays** as package manager, builder and publisher. `just` is an addition, not a transition.
- Files under 500 lines. DELETE, don't deprecate.

---

### Task 1: Package skeleton and config with a loopback default

**Files:**
- Create: `bridge/pyproject.toml`, `bridge/src/ble_bridge/__init__.py`, `bridge/src/ble_bridge/config.py`
- Test: `bridge/tests/test_config.py`

**Interfaces:**
- Produces: `Config(ws_host, ws_port)` frozen dataclass with `.ws_bind -> str` and `.is_loopback -> bool`; `from_env(env=None) -> Config`; `DEFAULT_WS_HOST = "127.0.0.1"`; `DEFAULT_WS_PORT = 8080`; `ConfigError`.

- [ ] **Step 1: Write the failing test** — `bridge/tests/test_config.py`

```python
import pytest
from ble_bridge.config import ConfigError, from_env

def test_default_bind_is_loopback():
    """The Rust bridge defaulted to 0.0.0.0. That must not carry over."""
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
    assert from_env({"BLE_MCP_WS_HOST": "0.0.0.0"}).is_loopback is False
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd bridge && uv run pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'ble_bridge'`

- [ ] **Step 3: Write `bridge/pyproject.toml`** (hatchling, src layout, `asyncio_mode = "auto"`, deps `websockets>=14`, dev group `pytest`/`pytest-asyncio`/`ruff`, console script `ble-bridge = "ble_bridge.__main__:main"`).

- [ ] **Step 4: Write `bridge/src/ble_bridge/config.py`** — env only, no file parsing. Blank/whitespace treated as absent; unparseable or out-of-range port raises `ConfigError` rather than falling back.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd bridge && uv run pytest tests/test_config.py -v`
Expected: 7 passed

- [ ] **Step 6: Commit**

---

### Task 2: `protocol.py` — the single owner of every wire message name

**Files:**
- Create: `bridge/src/ble_bridge/ws/__init__.py`, `bridge/src/ble_bridge/ws/protocol.py`
- Test: `bridge/tests/test_protocol.py`

**Interfaces:**
- Produces: `MSG_CONNECTED`, `MSG_DATA`, `MSG_ERROR`, `SERVER_MESSAGE_TYPES`, `CLIENT_MESSAGE_TYPES`, `MISSING_PARAMS_ERROR`, `encode_connected(device) -> str`, `encode_data(payload: bytes) -> str`, `encode_error(message) -> str`, `decode(raw) -> dict`, `data_payload(msg) -> bytes`, `ProtocolError`.

- [ ] **Step 1: Write the failing test**, asserting the exact shapes against the TS line
      references, that dropped types are absent from both tuples, and — the load-bearing
      one — `test_no_message_type_literal_outside_protocol`, which walks every `.py` in
      the package and fails on any message-type string literal outside `protocol.py`.

- [ ] **Step 2: Run it and confirm it fails**

- [ ] **Step 3: Write `bridge/src/ble_bridge/ws/protocol.py`**

- [ ] **Step 4: Run the tests and confirm they pass**

- [ ] **Step 5: Break the subject to prove the mechanical check works.** Execution proves
      a check ran; breaking the subject proves it works. Temporarily add `x = "connected"`
      to `config.py`, re-run the literal test, confirm it FAILS naming `config.py`, revert,
      confirm it passes again.

- [ ] **Step 6: Commit**

---

### Task 3: The nine URL query parameters

**Files:**
- Create: `bridge/src/ble_bridge/ws/params.py`
- Test: `bridge/tests/test_params.py`

**Interfaces:**
- Produces: `ConnectionParams(service, write, notify, session, session_was_provided, mock_version, force, device_id, device_name, timeout)`; `parse_params(path_or_query, *, session_factory=uuid4_str)`; `MissingParametersError`; `InvalidParameterError`.

- [ ] **Step 1: Write the failing test** covering all nine parsed; each of
      service/write/notify individually required; blank counts as absent; session
      generated when absent and kept when provided; `force` exactly `"true"`;
      optional filters default `None`; unparseable `timeout` raises; UUIDs pass
      through unnormalised.

- [ ] **Step 2: Run it and confirm it fails**
- [ ] **Step 3: Write `params.py`**
- [ ] **Step 4: Run the tests and confirm they pass**
- [ ] **Step 5: Commit**

**Deliberate divergence to flag in the PR:** TS `parseInt('abc')` yields NaN and passes it
down silently. Here it raises. Present, wrong, and silently ignored is failure class 2.

---

### Task 4: The transport seam and an injecting stub

**Files:**
- Create: `bridge/src/ble_bridge/transport.py`
- Test: `bridge/tests/test_transport.py`

**Interfaces:**
- Produces: `DeviceInfo(name, id)`; `BleTransport` runtime-checkable Protocol with
  `set_data_callback(cb)`, `async connect() -> DeviceInfo`, `async write(bytes)`,
  `async cleanup()`, `is_connected() -> bool`; `TransportFactory`; `StubTransport`
  with `.writes` and `.inject(payload)`.

Mirrors `src/ble-transport.ts`, which TRA-1156 wrote specifically so "the Python rewrite
has an explicit contract to reproduce". Keep the shape.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run it and confirm it fails**
- [ ] **Step 3: Write `transport.py`**
- [ ] **Step 4: Run the tests and confirm they pass**
- [ ] **Step 5: Commit**

---

### Task 5: The relay — `connected` and `data` in both directions

**Files:**
- Create: `bridge/src/ble_bridge/ws/server.py`, `bridge/src/ble_bridge/__main__.py`
- Test: `bridge/tests/test_relay.py`

**Interfaces:**
- Produces: `BridgeServer(config, transport_factory)` with `async start() -> int`
  (bound port), `async stop()`, `.port`; `main()` for the console script.

**Design notes the implementer must not simplify away:**

1. **One queue, one sender.** Notifications are put on an `asyncio.Queue` by the
   transport callback and drained by a single sender task per connection. Awaiting
   `ws.send` inside the callback would block the transport's loop; a task per
   notification would reorder them, and the firehose's sequence-gap accounting would
   report reordering as loss.
2. **The transport is built inside the per-connection handler, not at process start.**
   This is the deliberate divergence from `rust-ble-test`'s `main.rs`, which calls
   `transport.connect()` once and holds the radio for the process lifetime — making
   process lifetime a resource claim that blocks every direct-Web-Bluetooth workflow on
   the machine. Here, a daemon with no clients holds nothing.
3. **The startup log states the reachable address and the radio state**, because "up"
   and "holding the reader" are otherwise indistinguishable to an operator.

- [ ] **Step 1: Write the failing test** — `connected` on a valid connection;
      notification → `data`; client `data` → transport write; 200-notification order
      preservation; each missing required param yields the documented error then close;
      no transport is built when params are missing; absent `_mv` warns and changes
      nothing; mismatched `_mv` warns and changes nothing. Fixture binds an ephemeral
      loopback port and asserts it is never 8080.

- [ ] **Step 2: Run it and confirm it fails**
- [ ] **Step 3: Write `ws/server.py`**
- [ ] **Step 4: Write `__main__.py`**
- [ ] **Step 5: Run the whole suite and confirm it passes**
- [ ] **Step 6: Commit**

---

### Task 6: The Python firehose — drive the relay at rate with no reader

**Files:**
- Create: `bridge/tests/stress/__init__.py`, `bridge/tests/stress/firehose.py`, `bridge/tests/stress/test_firehose.py`

**Interfaces:**
- Produces: `FIREHOSE_HEADER_BYTES = 12`, `FIREHOSE_FILLER = 0xA7`,
  `DEFAULT_PAYLOAD_BYTES = 20`, `encode_firehose_payload(seq, t_inject_ms, payload_bytes)`,
  `decode_firehose_payload(data) -> (seq, t_inject_ms)`, `FirehoseTransport`,
  `async run_firehose(...) -> FirehoseResult`.

Mirror `tests/stress/firehose-transport.ts` on the wire: 12-byte header (`seq` uint32 LE,
injection timestamp float64 LE), `0xA7` filler, 20 bytes by default, absolute drift-free
scheduling, and a per-tick cap whose hits are counted separately — a generator that cannot
keep up is a shortfall in the INSTRUMENT and must never be reported as relay loss.

**The honest-comparison constraint, to be written into the module docstring:** this
measures a Python injector against a Python consumer. The TS baseline measured a Node
injector against a Node consumer sharing one `performance.now()`. Throughput and loss are
comparable across the two; **latency is not**, because both the consumer and the clock
arrangement differ. Report loss and achieved rate as acceptance evidence; do not print a
latency comparison against the 0.010–0.020 ms baseline figures.

- [ ] **Step 1: Write the failing test** — payload round-trip; undersized payload refused;
      zero loss at a functional rate; **the loss-detection self-test** (`drop_every_nth=10`
      must be *detected*, because a harness that always reports zero loss is
      indistinguishable from one that cannot detect loss at all); opt-in rate ladder
      gated on `FIREHOSE_BASELINE`.
- [ ] **Step 2: Run it and confirm it fails**
- [ ] **Step 3: Write `firehose.py`**
- [ ] **Step 4: Run the tests and confirm they pass**
- [ ] **Step 5: Run the opt-in ladder and record the real numbers.** A non-zero
      `saturated_ticks` invalidates that row as a statement about the relay.
- [ ] **Step 6: Commit**

---

### Task 7: `just` as the cross-language front door, and the pm2 script cleanup

**Files:**
- Create: `justfile`, `bridge/justfile`
- Modify: `package.json` (remove the 11 `pm2:*` scripts and the `pm2` dependency),
  `.claude/csw.json` (`validate` → `just validate`)

**Scope discipline:** remove only the 11 `pm2:*` scripts and the `pm2` dependency they are
the sole consumer of. `ecosystem.config.cjs` and `SERVICE.md` are orphaned by this and are
NOT deleted here — flag them in the PR for a follow-up rather than deleting files the
ticket did not name.

- [ ] **Step 1: Write `bridge/justfile`** (`lint`, `fmt`, `test`, `firehose`, `validate`)
- [ ] **Step 2: Write the root `justfile`** (`lint-ts`/`lint-py`, `test-ts`/`test-py`,
      `build`, aggregate `lint`/`test`/`validate`)
- [ ] **Step 3: Remove the 11 pm2 scripts and the pm2 dependency; `pnpm install`**
- [ ] **Step 4: Point `.claude/csw.json` `validate` at `just validate`**
- [ ] **Step 5: Run `just validate` and report the real output.** A gate that was skipped
      is a gate that did not run.
- [ ] **Step 6: Commit**

---

## Self-Review

**Spec coverage.** Ticket acceptance → task: `connected`/`data` conform in both directions
→ 2, 5. Nine parameters parse → 3. Documented error on missing service/write/notify → 3, 5.
Firehose drives it with no reader → 6. Loopback bind default with a test asserting loopback
→ 1. `_mv` as telemetry only → 5. `just` adoption and script cleanup → 7. csw `validate` → 7.

**Deliberate divergences from the TypeScript, both flagged in the PR:** an unparseable
`timeout` raises rather than becoming NaN; an unparseable `BLE_MCP_WS_PORT` raises rather
than falling back. Both are CLAUDE.md failure class 2.

**Deferred with a named owner:** UUID normalisation, session reuse and force-takeover
semantics, `error`/`warning` beyond validation, and `force_cleanup` — TRA-1158 and
TRA-1159. `force` and `session` are parsed and carried; they are not yet acted on.
