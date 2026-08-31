# CLAUDE.md

@AGENTS.md

## What this is

Browser-based E2E tests controlling **real BLE hardware** from headless environments (CI, VMs, containers, Claude Code sessions).

**We mock the `navigator.bluetooth` Web API — not the hardware.** Commands flow browser → mock → WebSocket → Python bridge → ESPHome proxy → real device, and back. If no device is reachable, connections fail; that is correct behaviour, not a bug in the mock.

Device-agnostic by design: any GATT device works, configured by UUID env vars. CS108 UHF RFID is the reference device, not a requirement.

## Architecture

```
[Playwright/browser] → [mock-bluetooth.ts] → (WebSocket) → [Python bridge] → [ESPHome proxy over TCP] → [BLE device]
```

One bridge: **Python**, in `bridge/`. There is no local-radio path.

This repo publishes **one client** and no server: the Web Bluetooth mock, in two entry points — `.` for anything that can `import`, `./browser` (IIFE) for `addInitScript` and `transformIndexHtml`, which cannot. The axis is import-vs-inject, not browser-vs-node. No contract member may differ by how the package was built. `ble-mcp-test/node` was deleted in 0.9.0.

The bridge holds **one writer slot** — not a pool, not keyed on session. A second connection is refused `Device is busy` even carrying the same session id. Release completes when the server processes the socket close, so **await disconnect** or the next connect races it.

**Two contracts, both binding.** The wire is `docs/design/2026-08-23-ws-protocol-spec.md` — **that document is the acceptance criterion**, not any message count. It is silent on reconnect semantics; `docs/API.md` covers those. The client surface is `docs/design/2026-08-27-client-contract.md`, held by `tests/conformance/`.

**Fidelity to the real Web Bluetooth API outranks the mock.** Where they differ the mock is wrong, unless the client contract's deliberate-divergences table says otherwise. A consumer's green e2e run is never evidence of fidelity.

Async/await only for BLE operations; callbacks only in event handlers.

## Testing

```bash
just validate       # the whole gate: lint + typecheck + both test suites
just test           # TS unit + Python, no bridge, no hardware
pnpm test:e2e       # Playwright — ALWAYS headless, never headless:false; needs a running bridge
cd bridge && just hardware   # opt-in, needs a real device
```

`just validate` is what `.claude/csw.json` runs, and it must mean the whole gate from any directory — `bridge/justfile`'s `validate` delegates upward for exactly that reason.

**No test counts here** — every hand-written one has drifted. Run the command.

**Hardware reality.** `cd bridge && just hardware` drives a live CS108 over TCP through the ESPHome proxy, no local radio: needs `ESPHOME_PROXY_HOST` + `BLE_MCP_DEVICE_MAC` and a powered reader, holds the device ~2 min, and fails rather than falling back to the stub. Skipped by default.

**The bridge runs as a systemd `--user` unit** — `just bridge-install` once, `just bridge-restart` after any `bridge/` change, `just bridge-check` to verify. Never a system unit. `docs/bridge-service.md`.

**Install it from the main checkout, not a worktree** — `bridge-install` refuses in one. A hand-started daemon is fine for debugging; confirm it logged `ESPHome transport:` and not the stub.

**`pnpm run pretest` fails a run whose bridge predates the last `bridge/` commit.** The remedy it names is `just bridge-restart`.

**Gitignored is not glob-invisible.** `vitest.config.ts` must exclude `.claude/worktrees/**` or a run collects sibling worktrees' tests; `tests/unit/vitest-isolation.test.ts` guards it.

## Known failure classes

Two bug classes recur in this codebase. Design against both.

1. **A waiter whose condition cannot be satisfied by what is actually sent** — fails as a *timeout*, so it looks like slowness. Check every wait condition against its emitter **mechanically** (a test, or a shared constant both sides derive from), never by eye.
2. **A silent fallback that looks like configuration** — succeeds against the *wrong input*, so it looks like correctness and nothing is even slow. Require the variable; fail loudly when absent; never fall back.

## Notes

- **Node version:** `.nvmrc` pins 24, `engines` sets `>=24.0.0`. No dependency requires it — the only runtime dependency left is `ws`. The pin exists because **platform pins 24**; matching the primary consumer's runtime is the reason. Do not lower it to a dependency floor.
