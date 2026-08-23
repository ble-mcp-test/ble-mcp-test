# CLAUDE.md

## What this is

Browser-based E2E tests controlling **real BLE hardware** from headless environments (CI, VMs, containers, Claude Code sessions).

**We mock the `navigator.bluetooth` Web API — not the hardware.** Commands flow browser → mock → WebSocket → bridge → real device, and back. If no device is reachable, connections fail; that is correct behaviour, not a bug in the mock.

Device-agnostic by design: any GATT device works, configured by UUID env vars. CS108 UHF RFID is the reference device, not a requirement.

## Architecture

```
[Playwright/browser] → [mock-bluetooth.ts] → (WebSocket) → [bridge] → [ESPHome proxy over TCP] → [BLE device]
```

Two bridge implementations exist today:
- **TypeScript** (`src/`) — Noble/BlueZ, requires a local radio. Frozen.
- **Rust** (`rust-ble-test/`) — ESPHome proxy over TCP, no local radio. What actually runs.

Both are being replaced by a **Python** server. See `docs/design/2026-08-23-python-bridge-rewrite.md` and TRA-1155/1156-1163. The WS contract is specified in `docs/design/2026-08-23-ws-protocol-spec.md` — **treat that document as the acceptance criterion**, not any message count.

## Package Manager

**pnpm EXCLUSIVELY** — never `npm`, `npx`, or `yarn`. `npx` → `pnpm dlx` or `pnpm exec`.

Rust: `cargo` in `rust-ble-test/`. Python (incoming): `uv`.

## Git Workflow

- **Never push directly to main** — all changes via PR, no exceptions
- **Never squash merge** — `gh pr merge --merge`, preserve commit history
- **Never merge without explicit confirmation**
- Branch naming: `<type>/tra-NNNN-slug` (e.g. `fix/tra-1157-ws-relay`); `feat:`/`fix:`/`docs:`/`chore:`/`refactor:`/`test:`
- Conventional commits; prefer incremental commits over amending

## Worktrees

Worktrees go in **`.claude/worktrees/<name>/`** — the canonical location across all trakrf repos (docs/platform/infra). Create with the native `EnterWorktree` tool. Do **not** use manual `git worktree add`, and do **not** create a root-level `.worktrees/` or a symlink bridge to one (fresh-clone footgun). `git worktree list` is authoritative for cleanup.

## Testing

```bash
pnpm test           # unit + integration
pnpm test:unit      # 74 tests, no bridge, no hardware
pnpm test:e2e       # Playwright — ALWAYS headless, never headless:false
```

**Hardware reality:** ~10 e2e tests need a powered device in range; **none** need a staged tag field. They currently cannot run anywhere — this container has no usable Bluetooth stack (`AF_BLUETOOTH` → errno 97) and the TS bridge is Noble-only. Do not report the hardware subset as passing or failing; report it as **unexecutable**.

`pnpm run check:device` scans for a local radio — it cannot work here.

## Known failure classes

Two bug classes recur in this codebase. Design against both.

1. **A waiter whose condition cannot be satisfied by what is actually sent** — fails as a *timeout*, so it looks like slowness. Check every wait condition against its emitter **mechanically** (a test, or a shared constant both sides derive from), never by eye.
2. **A silent fallback that looks like configuration** — succeeds against the *wrong input*, so it looks like correctness and nothing is even slow. Require the variable; fail loudly when absent; never fall back.

## Verification

- Run the command before claiming completion; report actual output — **no false optimism**
- A masking or renaming pass is verified by **execution**, not by grep
- If tests fail, say so with the output. If a step was skipped, say that.

## Style

- **DELETE, don't deprecate** — no `.old` files, no commented-out code
- Async/await only for BLE operations; callbacks only in event handlers
- Keep files under 500 lines
- Ask when requirements are unclear; never delete code without explicit instruction

## Notes

- `prp/archive/` is dead historical spec — do not treat it as current
- **Node version:** `package.json` declares `engines: {node: ">=24.0.0"}`, but nothing in the dependency tree justifies it — `@stoprocent/noble@2.3.5` declares `>=14`, no package in the lockfile requires `>=22` or above, and `@types/node` is pinned to `^20`. The 24 floor is a leftover from an older Noble; treat `engines` as the source of truth until it is revisited, not this file.
