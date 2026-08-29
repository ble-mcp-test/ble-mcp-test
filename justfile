# Cross-language front door.
#
# ble-mcp-test publishes two clients to npm -- the browser mock and the Node
# test-harness client -- so pnpm remains the package manager, builder and
# publisher; just delegates to it rather than replacing it. The server is
# Python and goes through uv in bridge/.
#
# Never npm, npx or yarn. `npx` is `pnpm dlx` or `pnpm exec`.

default: validate

# --- TypeScript workspace ---

# Bootstrap. Every TS recipe depends on this because a fresh clone -- and every
# new worktree, which is the case that actually bites -- starts without
# node_modules, and `pnpm run lint` then fails with `eslint: not found` rather
# than with anything that names the real problem. Idempotent and ~1s when the
# store is warm. The Python side needs no equivalent: `uv run` syncs its own venv.
install:
    pnpm install --frozen-lockfile

lint-ts: install
    pnpm run lint

# TWO configs, both required. `typecheck` covers src/ under the BUILD config, so a
# declaration this package publishes cannot be wrong. `typecheck:tests` covers
# src/ AND tests/ -- it exists because for weeks nothing typechecked a test file
# at all: the build config includes src/ only, and the one config that did cover
# tests (tsconfig.test.json) was wired into no recipe. Three dangling imports sat
# in tests/stress/ from 17e94f4 until TRA-1187 went looking. Execution was the
# only thing validating any test file here, so anything neither run nor
# typechecked rotted silently.
typecheck-ts: install
    pnpm run typecheck
    pnpm run typecheck:tests

test-ts: install
    pnpm run test:unit
    pnpm run test:conformance

build-ts: install
    pnpm run build

# --- Python workspace (bridge/) ---

lint-py:
    cd bridge && just lint

test-py:
    cd bridge && just test

fmt-py:
    cd bridge && just fmt

# Opt-in relay rate ladder. See bridge/justfile for the caveats.
firehose seconds="10":
    cd bridge && just firehose {{seconds}}

# --- Aggregates, spanning both languages ---

lint: lint-ts lint-py

test: test-ts test-py

build: build-ts

# `build` is NOT optional here. Two checks in tests/unit/entry-points.test.ts are
# `it.skipIf(!built)` -- they verify the exports map is honoured and that the ESM
# entry point reaches no filesystem API. Without a build in this recipe, a fresh
# clone runs the gate GREEN with both silently absent, and the second is the guard
# for the exact bug that made the `.` entry point unusable: a dynamic import()
# reaching fs from inside connect(). A guard that quietly does not run has no
# symptom, which is this repo's first named failure class wearing a build flag.
validate: lint typecheck-ts build test

# Arm B of the conformance suite: the SAME contract checks, against REAL Chromium
# navigator.bluetooth instead of the mock. Opt-in, like `just hardware`, and for
# the same reason -- it needs hardware. `just test` runs arm A, which can only
# establish that the mock agrees with ITSELF; only this arm can establish that it
# agrees with the API it doubles.
#
# Needs BLE_MCP_CONFORMANCE_ARM_B=1, a machine whose Chromium can reach a real BLE
# adapter (BlueZ over D-Bus -- the ESPHome proxy is the bridge's route, not
# Chrome's), and a powered peripheral in range. See the header of
# playwright.conformance.config.ts for what is unfinished.
conformance-real:
    BLE_MCP_CONFORMANCE_ARM_B=1 pnpm run test:conformance:real

# Hardware-dependent. Needs a powered device in range and a running bridge.
# A local Bluetooth stack is NOT required: the bridge reaches the device over
# TCP through the ESPHome proxy, so this runs in a container with no BlueZ.
test-e2e:
    pnpm run test:e2e

# --- The bridge daemon, supervised (see docs/bridge-service.md) ---

# Install `ble-bridge.service` as a systemd --user unit and prove it came up.
#
# Renders deploy/ble-bridge.service with THIS checkout's path, so a second box
# runs the same recipe and gets its own bridge. Never a system unit: the MCP
# control socket lives under /run/user/<uid>, which does not exist for one.
bridge-install:
    #!/usr/bin/env bash
    set -euo pipefail
    # A worktree is deleted when its branch merges, and the unit would keep
    # pointing at the hole -- silently, until the next boot. Install from the
    # checkout that is going to stay.
    if [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ]; then
        echo "Refusing: this is a linked worktree, and it will not outlive its branch."
        echo "Install from the main checkout: $(dirname "$(git rev-parse --git-common-dir)")"
        exit 1
    fi
    if [ ! -x bridge/.venv/bin/python3 ]; then
        echo "bridge/.venv/bin/python3 does not exist -- ExecStart would point at nothing."
        echo "Create it first:  cd bridge && uv sync"
        exit 1
    fi
    unit="$(node scripts/bridge-service.js unit-path)"
    mkdir -p "$(dirname "$unit")"
    node scripts/bridge-service.js render > "$unit"
    echo "wrote $unit"
    systemctl --user daemon-reload
    systemctl --user enable --now ble-bridge.service
    just bridge-check

# The one word to type after anything under bridge/ changes. The staleness guard
# in `pnpm run pretest` fails a run rather than letting a stale daemon answer it,
# and this is what it tells you to run.
bridge-restart:
    systemctl --user restart ble-bridge.service
    just bridge-check

# Assert the running daemon is what the unit claims: active, MainPID is the
# interpreter rather than a `uv` wrapper, a REAL ESPHome transport and not the
# stub, a log level that is not debug, /status answering, the MCP socket present,
# and not older than the last commit touching bridge/.
bridge-check:
    node scripts/bridge-service.js check

bridge-log:
    journalctl --user -u ble-bridge.service -f
