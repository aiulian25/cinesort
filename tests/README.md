# Tests

Regression guards for the seams where CineSort's bugs have actually lived:
filename detection, template/path building, and the manual-match overrides.

## Running them

pytest is a **dev-only** dependency and is deliberately NOT installed into
`.venv`: `package.json` ships that venv wholesale into every deb/rpm/AppImage
(`extraResources`), so anything installed there lands on users' disks. It is
installed beside it instead:

```bash
.venv/bin/pip install --target .devtools "pytest>=8.0"     # once
PYTHONPATH=.devtools .venv/bin/python3 -m pytest tests/ -q
```

`tests/` is excluded from both build targets already — `package.json` packs
only `electron/**` and `app/**`, and the Dockerfile copies only `app/`. Nothing
here reaches a released artifact.

## What each file covers

| File | Guards against |
|---|---|
| `test_detector.py` | F8 noise tokens diluting the title; the regexes eating real titles (`The Italian Job`, `Spider-Man`); SxE/date/anime detection regressions |
| `test_formatter.py` | F7 over-long names — byte (not character) limits, multi-byte safety, extension survival |
| `test_match_overrides.py` | F4/F5 explicit picks being refused or silently dropped; the `pinned` contract, including subtitle inheritance |

No network: the match tests stub the provider clients, so the suite runs
offline and identically on every platform.
