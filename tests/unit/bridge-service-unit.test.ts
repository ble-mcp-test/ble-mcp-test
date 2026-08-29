import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROTECTED_MARKERS } from '../../scripts/port-cleanup.js';
import { REPO_ROOT, TEMPLATE, UNIT, installedUnitPath, renderUnit } from '../../scripts/bridge-service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const template = readFileSync(TEMPLATE, 'utf8');

/** Directive lines only, so a directive named inside a comment cannot satisfy a check. */
const directives = template
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

/**
 * The directives as one blob, for the "must NOT contain" assertions.
 *
 * Deliberately not the whole file. Several of these checks exist because a
 * directive would be WRONG, and the unit explains why in a comment right next
 * to where it would have gone -- so a whole-file search finds the explanation
 * and fails, which would make documenting a trap impossible.
 */
const config = directives.join('\n');

/** The section a directive is in, since systemd rejects several of these in the wrong one. */
function sectionOf(directive: string): string | null {
  let section: string | null = null;
  for (const line of directives) {
    if (line.startsWith('[')) { section = line; continue; }
    if (line.startsWith(directive)) return section;
  }
  return null;
}

describe('deploy/ble-bridge.service', () => {
  it('lives where the repo says it does', () => {
    expect(TEMPLATE).toBe(path.join(REPO_ROOT, 'deploy', 'ble-bridge.service'));
    expect(UNIT).toBe('ble-bridge.service');
  });

  it('requires the env file: EnvironmentFile= with NO leading dash (TRA-1184)', () => {
    // `EnvironmentFile=-` means "start anyway if it is missing", which brings up
    // a daemon with no proxy host and no device MAC that reports healthy and
    // relays nothing. This is the one line in the unit that must never be
    // copied from prior art without reading it.
    expect(directives).toContain(`EnvironmentFile=${'@REPO_ROOT@'}/.env.local`);
    expect(config).not.toMatch(/^EnvironmentFile=-/m);
  });

  it('starts the interpreter directly, so MainPID is the daemon and not a wrapper', () => {
    const execStart = directives.find((l) => l.startsWith('ExecStart='));
    expect(execStart).toBe('ExecStart=@REPO_ROOT@/bridge/.venv/bin/python3 -m ble_bridge');
    expect(config).not.toMatch(/^ExecStart=.*uv run/m);
  });

  it('keeps the daemon matching the protected-process marker pretest uses', () => {
    // The coupling that would otherwise be a comment. The venv also ships a
    // `ble-bridge` console script; its argv reads `.../bin/ble-bridge`, with a
    // HYPHEN, and would stop matching `ble_bridge`. pretest would then judge
    // the supervised daemon unprotected and kill it to free the port -- the
    // TRA-1170 failure, reintroduced through the launch path.
    const execStart = directives.find((l) => l.startsWith('ExecStart='))!;
    expect(PROTECTED_MARKERS.some((m) => execStart.includes(m))).toBe(true);
  });

  it('runs from bridge/, which is what makes .env.local findable and the checkout knowable', () => {
    // `_load_env_file()` searches upward for .env.local, and
    // scripts/bridge-staleness.js reads /proc/<pid>/cwd to find the checkout
    // this daemon is serving. Both depend on this line.
    expect(directives).toContain('WorkingDirectory=@REPO_ROOT@/bridge');
  });

  it('restarts, and gives up loudly rather than looping on a permanent failure', () => {
    expect(directives).toContain('Restart=always');
    expect(directives).toContain('RestartSec=5');
    // StartLimit* belong in [Unit]; systemd ignores them in [Service], which
    // would leave a missing .env.local restarting every five seconds forever
    // instead of reaching `failed` and saying so.
    expect(sectionOf('StartLimitIntervalSec=')).toBe('[Unit]');
    expect(sectionOf('StartLimitBurst=')).toBe('[Unit]');
  });

  it('is a user unit, and names only targets a user manager actually has', () => {
    // A system unit would create no /run/user/<uid>, so the MCP control socket
    // -- and with it get_logs, search_packets, get_connection_state -- would
    // silently not exist while the daemon looked healthy.
    expect(directives).toContain('WantedBy=default.target');
    expect(config).not.toMatch(/multi-user\.target/);
    // `systemctl --user show network-online.target` reports LoadState=not-found:
    // a user manager has no such unit, so naming it would be an inert
    // dependency that reads as a real one.
    expect(config).not.toMatch(/network-online\.target/);
  });

  it('does not pretend to set a log level it cannot set', () => {
    // Measured on systemd 255, both declaration orders: EnvironmentFile=
    // overrides Environment= for the same key. An Environment=BLE_MCP_LOG_LEVEL
    // line would be silently beaten by .env.local, and config.py already
    // defaults to INFO -- so there is no case in which it does anything.
    expect(config).not.toMatch(/^Environment=BLE_MCP_LOG_LEVEL/m);
  });

  it('hardcodes nothing about the box it was written on', () => {
    // Scope item 6: a second checkout, on another box, installs this same file.
    expect(config).not.toMatch(/\/home\/[a-z]/);
    expect(config).not.toMatch(/\/run\/user\/\d+/);
  });
});

describe('renderUnit', () => {
  it('substitutes every placeholder', () => {
    const rendered = renderUnit(template, '/srv/ble-mcp-test');
    expect(rendered).not.toMatch(/@[A-Z0-9_]+@/);
    expect(rendered).toContain('ExecStart=/srv/ble-mcp-test/bridge/.venv/bin/python3 -m ble_bridge');
    expect(rendered).toContain('EnvironmentFile=/srv/ble-mcp-test/.env.local');
  });

  it('tolerates a trailing slash on the repo root rather than emitting a double one', () => {
    expect(renderUnit(template, '/srv/ble-mcp-test/')).toContain('/srv/ble-mcp-test/bridge/.venv');
  });

  it('refuses a relative repo root', () => {
    expect(() => renderUnit(template, '../ble-mcp-test')).toThrow(/must be absolute/);
  });

  it('refuses to emit a unit with a placeholder still in it', () => {
    // systemd would take `@SOMETHING@/x` as a path, fail to execute it, and
    // report a start failure naming a file nobody will recognise.
    expect(() => renderUnit('ExecStart=@REPO_ROOT@/x @LEFTOVER@\n', '/srv/x'))
      .toThrow(/still contains a placeholder: @LEFTOVER@/);
  });

  it('refuses a template that has lost its placeholder', () => {
    expect(() => renderUnit('ExecStart=/somewhere/python3\n', '/srv/x'))
      .toThrow(/no @REPO_ROOT@ placeholder/);
  });
});

describe('installedUnitPath', () => {
  it('is the user unit directory, not a system one', () => {
    expect(installedUnitPath('/home/someone')).toBe(
      '/home/someone/.config/systemd/user/ble-bridge.service'
    );
  });
});

describe('the docs point at the unit that exists', () => {
  it('names the real unit and the --user scope', () => {
    const doc = readFileSync(path.resolve(HERE, '../../docs/bridge-service.md'), 'utf8');
    expect(doc).toContain(UNIT);
    expect(doc).toContain('systemctl --user');
    // The instruction TRA-1202 asked for by name.
    expect(doc).toContain('systemctl --user daemon-reload');
  });
});
