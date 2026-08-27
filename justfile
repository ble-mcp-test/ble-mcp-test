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

validate: lint typecheck-ts test

# Hardware-dependent. Needs a powered device in range and a running bridge.
# A local Bluetooth stack is NOT required: the bridge reaches the device over
# TCP through the ESPHome proxy, so this runs in a container with no BlueZ.
test-e2e:
    pnpm run test:e2e
