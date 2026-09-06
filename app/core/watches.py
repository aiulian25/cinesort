"""Watch-folder rules — auto-organize configuration.

Persisted as watches.json beside keys.env via the same config-dir abstraction
(config.py): /data/config in Docker (survives container recreation on the
/data volume), ~/.config/cinesort on desktop. Written atomically with the
tmp+rename pattern save_config uses.

Validation philosophy:
  - SAVE is strict (folder must exist, source/action allow-listed, template
    non-empty) — a rule that can't work is rejected with a reason.
  - LOAD checks shape only: a watch whose folder is temporarily missing (an
    unmounted NAS) must NOT be silently dropped from the config — the watcher
    logs and skips it at poll time instead.

The rules grant no capability the API didn't already have: /api/rename has
always accepted arbitrary absolute destinations, and the real boundary is the
process user's filesystem permissions (PUID/PGID + mounted volumes in Docker).
"""

import json
from pathlib import Path
from typing import Optional

from app.core.config import config_file

ALLOWED_SOURCES = {"tmdb", "tvmaze", "omdb", "musicbrainz"}
# Never "rename" (in-place renaming a download folder is pointless headless)
# and never "test" (a dry run nobody sees).
ALLOWED_ACTIONS = {"move", "copy", "reflink", "hardlink", "symlink", "keeplink"}
ALLOWED_MEDIA_TYPES = ("series", "movie", "music")
MAX_WATCHES = 10


def _clamped_confidence(value) -> Optional[float]:
    """A per-rule score floor in [0, 1], or None to follow the global one.

    Anything unparseable is None rather than 0: a typo in the config must not
    silently turn a rule into "rename whatever you matched, at any confidence".
    """
    if value is None or value == "":
        return None
    try:
        return min(1.0, max(0.0, float(value)))
    except (TypeError, ValueError):
        return None


def watches_file() -> Path:
    return config_file().parent / "watches.json"


def _clean(entry, check_fs: bool) -> Optional[dict]:
    """Normalized watch dict, or None when the entry is unusable."""
    if not isinstance(entry, dict):
        return None
    folder = str(entry.get("folder") or "").strip()
    template = str(entry.get("template") or "").strip()
    ds = entry.get("datasource")
    action = entry.get("action")
    out = str(entry.get("output_dir") or "").strip()

    if not folder or ds not in ALLOWED_SOURCES or action not in ALLOWED_ACTIONS:
        return None
    if not template or len(template) > 500:
        return None
    if check_fs:
        if not Path(folder).expanduser().is_dir():
            return None
        if out and not Path(out).expanduser().is_dir():
            return None

    return {
        "folder": str(Path(folder).expanduser().resolve()) if check_fs else folder,
        "datasource": ds,
        "template": template,
        "action": action,
        "output_dir": (str(Path(out).expanduser().resolve()) if (out and check_fs) else out),
        "enabled": bool(entry.get("enabled", True)),
        # Kodi/Jellyfin .nfo + poster for files this rule organizes.
        "write_sidecars": bool(entry.get("write_sidecars", False)),
        # ── Per-rule intent. Every one of these already exists as a choice in
        # the interactive path; a rule could not express any of them, so one
        # rule for ~/Downloads had to mean "everything, everywhere, at the
        # global threshold". Defaults reproduce exactly the old behaviour.
        "recursive": bool(entry.get("recursive", True)),
        "include_extras": bool(entry.get("include_extras", False)),
        # None = follow the global review threshold.
        "min_confidence": _clamped_confidence(entry.get("min_confidence")),
        # None = every type. An empty list means the same thing: a rule that
        # matches nothing is a broken rule, not an intent.
        "media_types": [t for t in (entry.get("media_types") or [])
                        if t in ALLOWED_MEDIA_TYPES] or None,
    }


def load_watches() -> list:
    f = watches_file()
    if not f.is_file():
        return []
    try:
        raw = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return []   # malformed file degrades to no watches, never a crash
    if not isinstance(raw, list):
        return []
    out = []
    for e in raw[:MAX_WATCHES]:
        v = _clean(e, check_fs=False)
        if v:
            out.append(v)
    return out


def save_watches(entries: list) -> list:
    """Validate strictly, persist atomically, return the saved list.
    Raises ValueError with a human reason on the first invalid entry."""
    if not isinstance(entries, list):
        raise ValueError("watches must be a list")
    if len(entries) > MAX_WATCHES:
        raise ValueError(f"At most {MAX_WATCHES} watch folders are supported")
    cleaned = []
    for i, e in enumerate(entries):
        v = _clean(e, check_fs=True)
        if v is None:
            raise ValueError(
                f"Watch #{i + 1} is invalid: the folder (and destination, if set) "
                f"must exist, the source/action must be supported, and the "
                f"template must be non-empty"
            )
        cleaned.append(v)
    f = watches_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cleaned, indent=2), encoding="utf-8")
    tmp.replace(f)
    return cleaned
