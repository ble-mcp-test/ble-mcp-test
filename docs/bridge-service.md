# Running the bridge as a service

The bridge daemon runs as a **`systemctl --user` service**, `ble-bridge.service`,
rendered from `deploy/ble-bridge.service` into `~/.config/systemd/user/`.

```bash
just bridge-install    # render, install, enable, start, verify
just bridge-check      # verify a running one
just bridge-restart    # after anything under bridge/ changes
just bridge-log        # journalctl -f for the daemon
```

`just bridge-install` is the whole procedure. What it does, if you would rather
type it:

```bash
mkdir -p ~/.config/systemd/user
node scripts/bridge-service.js render > ~/.config/systemd/user/ble-bridge.service
systemctl --user daemon-reload
systemctl --user enable --now ble-bridge.service
node scripts/bridge-service.js check
```

The unit is a **template**: `@REPO_ROOT@` is substituted with the absolute path
of the checkout you run `render` from. Nothing in it is specific to the machine
it was written on, so a second box — a peer container, another checkout — runs
the same three commands and gets its own bridge. Two bridges contending for one
reader is safe: the loser is refused in about two seconds through the ESPHome
proxy's allocation list, and the holder is never disturbed.

## Why `--user` and not a system unit

Not a preference. The MCP control socket is created under `$XDG_RUNTIME_DIR` —
`/run/user/1000/ble-bridge.sock`, mode 0600 — and **that directory does not
exist for a system unit**. A system-level service comes up looking perfectly
healthy while the entire MCP surface (`get_logs`, `search_packets`,
`get_connection_state`) is silently missing. That presents as "the MCP tools are
broken", not as "the unit is wrong", which is the expensive direction.

`loginctl show-user` reports `Linger=yes`, so a user unit starts at boot and
survives logout with no extra setup.

## Why the bridge is always on rather than owned by a consumer

It has at least three, and the longest-running one is not the one you would
guess: platform's frontend dev server, platform's unattended soak driver (8+
hours, headless), and this repo's own e2e suite and `prepublishOnly`. Tying the
lifecycle to any one of them means an overnight run depends on a dev server
nobody is watching.

**An idle bridge holds the port, not the radio.** Verified three ways: the
proxy's own accounting at release time (`used=0 free=4 limit=4 allocated=[]`), a
live `get_connection_state` reporting `held: false`, and ten hours of log
silence at DEBUG. So always-on costs a TCP port and one idle ESPHome API
connection, and it does not block hand-testing through real
`navigator.bluetooth`.

## Configuration comes from `.env.local`, and it is required

`EnvironmentFile=` carries **no leading dash**. A missing `.env.local` is a hard
start failure, on purpose: `EnvironmentFile=-` would start a daemon with no
`ESPHOME_PROXY_HOST` and no `BLE_MCP_DEVICE_MAC`, which reports healthy, relays
nothing, and still turns a browser suite green because trigger injection is
mock-side.

⚠ **`EnvironmentFile=` overrides `Environment=` for the same key** — measured on
systemd 255 with both declaration orders. So the unit deliberately sets no
`BLE_MCP_LOG_LEVEL`: a line there would be silently beaten by `.env.local` while
appearing to be in force. `.env.local` is the single source of truth, and
`bridge-check` asserts the level the daemon *resolved*, not the one the unit
asked for.

Keep `BLE_MCP_LOG_LEVEL=info`. At `debug` the log grows about 270MB in eight
hours — websockets frame logging dominates — and journald will evict everything
else on the box to hold it. For a debugging session, stop the unit and run the
daemon by hand rather than editing the level under a service that will be
restarted without you.

## `Restart=always` is safe, and the reason is not obvious

Idle expiry ends the **connection**, never the process. On idle the relay logs,
sends the client an `IDLE_TIMEOUT` refusal frame, and returns from the handler;
the server keeps listening. A quiet bench releases a session and the daemon
carries on, so `Restart=always` cannot loop on it.

*Idle release is a lease on the command path, not a process lifecycle.*

A start failure, by contrast, is always a configuration failure — nothing at
startup touches the network — so it is permanent. `StartLimitBurst=5` over
`StartLimitIntervalSec=60` makes five attempts five seconds apart, then stops:
the unit reaches `failed` and says so, instead of restarting forever with the
problem scrolling past.

There is no network ordering. `network-online.target` does not exist in a user
manager (`systemctl --user show network-online.target` reports
`LoadState=not-found`), and it is not needed: `transport_factory` builds one
transport per WebSocket connection and never connects at startup.

## The staleness guard

**An always-on service is a stale server, and supervision makes that more likely
rather than less** — nobody thinks to restart something that never crashes. On
2026-08-28 a daemon had to be killed before publishing because it was serving
pre-merge code.

`/status` cannot detect this. It reports `version: "0.1.0"`, the Python package
version, which has not moved through the entire replatform: the same answer for
today's code and for six-month-old code. A check that cannot go red.

So `pnpm run pretest` — which every `test`, `test:e2e` and `prepublishOnly` run
goes through — runs `scripts/bridge-staleness.js` instead:

1. resolve the WS port the run will use (`BLE_MCP_WS_PORT` → `.env.local` →
   25153, matching the precedence `__main__.py` itself uses)
2. find the pid *listening* on it. Nothing listening is a pass — there is no
   daemon to be stale
3. confirm that pid is the bridge before judging it
4. read `/proc/<pid>/cwd` to find **the checkout that daemon was started from**,
   and take two dates from it: the last commit touching `bridge/`, and the
   newest mtime under `bridge/src`
5. compare the process start time — from `/proc/<pid>/stat` plus `btime` —
   against **both**

**Both, because neither covers the other.** A `git commit` moves the commit date
without touching a file. A `git merge` rewrites the files, but
`git log -1 -- bridge/` still reports the date of the commit that *made* the
change rather than the merge that *brought it in* — which is precisely the
2026-08-28 shape: committed 09:50, daemon restarted 10:00, merged 11:00, commit
timestamp says current. The union is the sensitive direction on purpose: a false
stale costs one `just bridge-restart`, a false current is the entire failure and
is silent. `bridge/src` is the right directory because the venv installs the
package **editable** — `_editable_impl_ble_bridge.pth` points straight at it, so
those files are literally what the interpreter imports.

Three of the steps are deliberate corrections to the obvious version:

- **Discovery is by port, not by `systemctl show -p MainPID`.** `MainPID`
  answers "is the unit fresh", which is a narrower question than "is the process
  that will answer this run fresh". They diverge exactly when a stale ad-hoc
  daemon holds the port while the unit sits stopped.
- **The denominator is the daemon's own checkout, not the current tree.**
  Otherwise every worktree fails the moment it commits to `bridge/`, for a
  daemon serving `main` that is not stale at all.
- **The start time comes from `/proc`, not from `ps`.** `ps -o lstart=` has to
  be parsed as a date; `ps -o etimes=` is worse — on procps 4.0.4 it reports
  4123168576 elapsed seconds for a process a fraction of a second old, dating a
  just-restarted daemon to 1896 and making it the stalest thing on the system.

When it fires, the fix is `just bridge-restart`, which the message says.

## Verifying it, including that the guards can go red

`just bridge-check` asserts the unit is active, that `MainPID` is the
interpreter rather than a `uv` wrapper, that the daemon logged a **real ESPHome
transport and not the stub**, that the resolved log level is not `debug`, that
`/status` answers, that the MCP socket exists, and that the daemon is not stale.

Two of those have been shown to fail on purpose, which is the only thing that
makes them evidence:

- rename `.env.local`, `systemctl --user restart ble-bridge`, and the unit
  reaches `failed` rather than coming up on a stub
- start the daemon, commit something under `bridge/`, and `pretest` refuses to
  run

## Interop

`ble-bridge.service`, user scope, is the name to use in anything that reads
systemd's bookkeeping. Prefer not to: the bridge's own `status` surface answers
"is this the same process" without knowing anything about how it is supervised,
and a consumer that greps `journalctl --user -u ble-bridge` is coupled to the
unit name, the log destination and the log level all at once.
