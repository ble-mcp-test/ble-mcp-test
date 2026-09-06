/**
 * Every `scripts/…` path this repo shells out to has to exist.
 *
 * `pre-test-cleanup.js` spent an unknown stretch calling
 * `node scripts/check-device-available.js`, which 17e94f4 deleted along with
 * Noble and the local-radio path it scanned. Nothing noticed, because the only
 * trigger left was an env var nobody sets.
 *
 * When it did fire it did not say the script was missing. It caught the
 * ENOENT and printed "The BLE device is not responding to scans", in capitals,
 * telling the reader the hardware needed attention -- while the device was
 * powered, advertising, and had just passed the whole e2e suite. An upstream
 * failure wearing a downstream subsystem's name, which is the most expensive
 * shape of wrong a diagnostic can take.
 *
 * A missing file is the one part of that this can check mechanically, so it does.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** `scripts/foo.js`, wherever it appears in a command string. */
const SCRIPT_PATH = /scripts\/[A-Za-z0-9_.-]+\.(?:js|mjs|cjs)/g;

function referencesIn(text: string): string[] {
  return [...new Set(text.match(SCRIPT_PATH) ?? [])];
}

function sources(): Array<{ where: string; text: string }> {
  const out = [{ where: 'package.json', text: readFileSync(join(REPO_ROOT, 'package.json'), 'utf8') }];

  for (const entry of readdirSync(join(REPO_ROOT, 'scripts'), { withFileTypes: true })) {
    if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) {
      out.push({
        where: `scripts/${entry.name}`,
        text: readFileSync(join(REPO_ROOT, 'scripts', entry.name), 'utf8'),
      });
    }
  }

  return out;
}

describe('every scripts/ path this repo invokes exists', () => {
  it('finds the references at all, so a green run is not an empty search', () => {
    const all = sources().flatMap((s) => referencesIn(s.text));

    // Without this, a regex that silently stopped matching would make every
    // assertion below pass against nothing -- the guard would go quiet in
    // exactly the way the guard it replaces did.
    expect(all.length).toBeGreaterThan(3);
  });

  it.each(sources())('$where references only scripts that exist', ({ where, text }) => {
    const missing = referencesIn(text).filter((ref) => !existsSync(join(REPO_ROOT, ref)));

    expect(missing, `${where} refers to ${missing.join(', ')}, which is not in the tree`).toEqual([]);
  });
});
