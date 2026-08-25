# Cross-language front door.
#
# This is an addition, not a transition. ble-mcp-test is a published npm package
# with `main` and `bin`, so pnpm remains the package manager, builder and
# publisher; just delegates to it rather than replacing it. Python work goes
# through uv in bridge/.
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

typecheck-ts: install
    pnpm run typecheck

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

# Hardware-dependent. Needs a powered device in range; cannot run in a
# container with no Bluetooth stack.
test-e2e:
    pnpm run test:e2e
