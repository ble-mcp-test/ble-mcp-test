import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockBluetooth } from '../../src/mock-bluetooth.js';

/**
 * TRA-35, from the public repo as issue #3: a way to force availability off so a
 * test can exercise the no-adapter path deliberately.
 *
 * This deliberately lands *after* the real reading. Building the override first
 * would have produced another constant wearing a different value -- the exact
 * defect TRA-1174 removed, reintroduced under a nicer name. A knob that forces
 * `false` is only meaningful once `true` means something.
 *
 * Two properties the tests below exist to hold:
 *
 * 1. **It is off unless asked for.** An override that survives into a run nobody
 *    set it in is a check that cannot go red, which is where this method came
 *    from in the first place.
 * 2. **It is clearable back to the real reading**, not merely settable to the
 *    other constant. Otherwise a suite that simulates unavailability once is
 *    lying for the rest of its life.
 */

const CONFIG = { service: '9800', write: '9900', notify: '9901' };

function mock() {
  return new MockBluetooth('ws://localhost:25153', CONFIG);
}

const reachable = () => vi.fn().mockResolvedValue({ ok: true, status: 200 });
const unreachable = () => vi.fn().mockRejectedValue(new TypeError('fetch failed'));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('testing.setAvailability', () => {
  it('is not set by default, so the real reading is what answers', async () => {
    const f = reachable();
    vi.stubGlobal('fetch', f);
    const m = mock();
    expect(await m.getAvailability()).toBe(true);
    expect(f).toHaveBeenCalled(); // it actually asked, rather than assuming
  });

  it('forces false against a bridge that is demonstrably reachable', async () => {
    // The whole point: simulate no adapter without unplugging anything.
    const f = reachable();
    vi.stubGlobal('fetch', f);
    const m = mock();
    m.testing.setAvailability(false);
    expect(await m.getAvailability()).toBe(false);
  });

  it('does not consult the bridge at all while overridden', async () => {
    // A test simulating "no Bluetooth" should not need a bridge running.
    const f = reachable();
    vi.stubGlobal('fetch', f);
    const m = mock();
    m.testing.setAvailability(false);
    await m.getAvailability();
    expect(f).not.toHaveBeenCalled();
  });

  it('can force true, which is the case worth being careful about', async () => {
    // Symmetric for completeness, and it is the dangerous direction: this is
    // exactly the hardcoded `true` TRA-1174 deleted. Legitimate only because it
    // is opt-in, per-instance, and clearable -- none of which the constant was.
    vi.stubGlobal('fetch', unreachable());
    const m = mock();
    m.testing.setAvailability(true);
    expect(await m.getAvailability()).toBe(true);
  });

  it('clears back to the real reading, not to the other constant', async () => {
    const f = reachable();
    vi.stubGlobal('fetch', f);
    const m = mock();

    m.testing.setAvailability(false);
    expect(await m.getAvailability()).toBe(false);

    m.testing.setAvailability(null);
    expect(await m.getAvailability()).toBe(true);
    expect(f).toHaveBeenCalled(); // asked again, rather than flipping a stored value
  });

  it('still reports false from the real reading once cleared', async () => {
    // Clearing must restore a reading that can still go red, not one pinned true.
    vi.stubGlobal('fetch', unreachable());
    const m = mock();
    m.testing.setAvailability(true);
    expect(await m.getAvailability()).toBe(true);
    m.testing.setAvailability(null);
    expect(await m.getAvailability()).toBe(false);
  });

  it('does not leak between mock instances', async () => {
    // Per-instance, not module state. A leaked override would be a constant that
    // outlives the test that set it, which is the original bug's shape.
    vi.stubGlobal('fetch', reachable());
    const a = mock();
    const b = mock();
    a.testing.setAvailability(false);
    expect(await a.getAvailability()).toBe(false);
    expect(await b.getAvailability()).toBe(true);
  });

  it('leaves getReaderState alone, which reports the real world', async () => {
    // The override simulates the ADAPTER being absent. It must not fabricate
    // holder information -- two questions, two APIs, and only one is simulated.
    const body = { held: true, session: 'someone', acquired_at: null, held_seconds: 3 };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })
    );
    const m = mock();
    m.testing.setAvailability(false);
    expect(await m.testing.getReaderState()).toEqual(body);
  });
});
