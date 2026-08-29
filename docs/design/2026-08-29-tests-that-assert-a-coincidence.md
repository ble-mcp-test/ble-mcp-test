# Tests that assert a coincidence

**Status:** proposed
**Tracking:** TRA-1204
**Date:** 2026-08-29

A test can pass for months, be read approvingly in review, and assert nothing about
the code it names. This is the shape that does it, and the question that finds it.

## The shape

An assertion of **inequality between two values that have no reason to be equal**.

```python
assert expected_mock_version() != __version__
```

That line guarded `mock_version.py` for the length of the Python replatform. Its
stated purpose was real: `_mv` carries the npm package's version, and comparing it
against the Python package's version would warn about a mismatch on every healthy
connection, training the reader to ignore the one that matters.

But the assertion never checked that. It passed because one number was frozen at
`0.1.0` while the other moved — so *"these two values differ"* stood in for *"these
two constants are read from different sources"*. Wire `expected_mock_version()`
directly to `__version__` and the test still goes green for as long as the freeze
holds. The mechanism was never under test; only a coincidence of its current output
was.

TRA-1204 generated both versions from `package.json`, the coincidence ended, and the
test went red — not because anything broke, but because the world changed.

## Why it survives review

It reads as a guard against a specific, named, real bug, and the bug is real. Nothing
about the line looks weak. The weakness is that its subject is two *values* rather
than the *path* that produces them, and values are what a reader compares when
checking a test by eye.

It is also invisible while it holds. There is no failing run, no flake, no slow test
— the check runs, passes, and passes about something other than the subject. That
puts it in the same family as a green suite sitting above a schema that silently
discards the field under test, and as a `pgrep` that matches a binary which has been
deleted.

## The question that finds it

> **What edit to the code under test would turn this red?**

If there is no answer, the assertion is decorative. Apply it to any `!=`,
`not.toBe`, `toBeDefined`, `assertNotNull`, or `assert x is not None`.

For the version test the answer was *"none"* — no edit to `mock_version.py` could
falsify it while the two numbers differed, and no edit was needed to falsify it once
they agreed.

## The repair is usually to invert it, not to delete it

A dead assertion looks like clutter and deleting it feels tidy. Here that would have
lost real coverage. Both versions are now generated from `package.json`, so they must
**agree**, and the equality is load-bearing: a release bump that skips
`pnpm run version:sync` leaves `__version__` behind while the mock moves on, and the
bridge warns about a version mismatch on every healthy connection — precisely the
harm the module exists to prevent.

```python
assert expected_mock_version() == __version__
```

Same two values, same module, and now an edit to the code under test can falsify it.
The old test was pointing at something true the whole time; it simply was not
checking it.

## Do not take reassurance from how it failed

This one failed loudly, at the moment of the change, with a clear message. That is a
property of the **trigger** — a version sync is an abrupt way for the world to change
— not of the species. The same defect sitting above a slowly drifting value degrades
silently and stays green throughout the drift, and nothing announces the day it
stopped testing anything.

## Related

- `bridge/tests/test_mock_version.py` — the instance, and the inverted guard.
- The two runtime failure classes in `CLAUDE.md`. This is their test-side cousin: an
  over-satisfiable check, satisfied by the wrong subject.
- A warning whose stated reason is a current value expires when the value changes,
  and expires badly — the reader who checks the reason, finds it false, and discards
  a conclusion that is still correct has done everything right. `mock_version.py`'s
  docstring carried exactly that and was rewritten in the same change. Same root:
  a claim resting on what a value reads today rather than on what it means.
