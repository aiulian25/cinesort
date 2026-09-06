"""Shared UI preferences and custom template presets.

Persisted as prefs.json beside watches.json and aliases.json via the same
config-dir abstraction (config.py): /data/config in Docker (survives container
recreation on the /data volume), ~/.config/cinesort on desktop.

Why server-side at all: the Docker image is the recommended NAS deployment, so
"the app" is one instance with many browsers in front of it. Presets built on
the desktop were invisible on the laptop, and a preset edited in one browser
silently diverged from the watch rule that had copied its template.

What is deliberately NOT here: the theme and the last-scanned path. Those
describe the device you are sitting at, not how you organize your library, and
syncing them would fight the user across machines.

Validation is shape-only and mirrors the caps the UI already enforces. The
values arrive from a browser and are written to a file the server owns, so
every one of them is bounded — an unbounded "template" is a disk-filler.
"""

import json
from pathlib import Path
from typing import Optional

from app.core.config import config_file

# Matches CUSTOM_PRESETS_MAX in app/static/app.js — the UI refuses a 13th, and
# so does this, so a hand-edited file cannot smuggle more in.
MAX_CUSTOM_PRESETS = 12
MAX_PRESET_LABEL = 24
MAX_TEMPLATE = 500
MAX_PATH = 4096

ALLOWED_DATASOURCES = {"tmdb", "tvmaze", "omdb", "musicbrainz"}
# Deliberately not imported from renamer.RenameAction: prefs are shape-checked,
# and an action this build does not know should be dropped on load rather than
# rejected — a newer client's preference must not brick an older backend.
MAX_ACTION = 32


def prefs_file() -> Path:
    return config_file().parent / "prefs.json"


def _clean_preset(entry) -> Optional[dict]:
    if not isinstance(entry, dict):
        return None
    label = entry.get("label")
    template = entry.get("template")
    if not isinstance(label, str) or not isinstance(template, str):
        return None
    label, template = label.strip(), template.strip()
    if not label or not template:
        return None
    if len(label) > MAX_PRESET_LABEL or len(template) > MAX_TEMPLATE:
        return None
    return {"label": label, "template": template}


def _clean(raw: dict) -> dict:
    """Normalized prefs dict. Unknown and unusable values are dropped, never
    rejected: a preference file is a convenience, and one bad field must not
    cost the user the rest of it."""
    out: dict = {}
    if not isinstance(raw, dict):
        return out

    datasource = raw.get("datasource")
    if datasource in ALLOWED_DATASOURCES:
        out["datasource"] = datasource

    action = raw.get("action")
    if isinstance(action, str) and 0 < len(action) <= MAX_ACTION:
        out["action"] = action

    template = raw.get("template")
    if isinstance(template, str) and 0 < len(template) <= MAX_TEMPLATE:
        out["template"] = template

    destination = raw.get("destination")
    if isinstance(destination, str) and len(destination) <= MAX_PATH:
        out["destination"] = destination

    for flag in ("subfolders", "include_extras", "write_sidecars"):
        if isinstance(raw.get(flag), bool):
            out[flag] = raw[flag]

    presets = raw.get("custom_presets")
    if isinstance(presets, list):
        cleaned = [p for p in (_clean_preset(e) for e in presets) if p]
        out["custom_presets"] = cleaned[:MAX_CUSTOM_PRESETS]

    return out


def load_prefs() -> dict:
    f = prefs_file()
    if not f.is_file():
        return {}
    try:
        raw = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return {}   # malformed file degrades to no prefs, never a crash
    return _clean(raw)


def save_prefs(raw: dict) -> dict:
    """Merge into what is stored and persist atomically. Returns the result.

    A MERGE, not a replace: one browser saving its template must not wipe the
    custom presets another browser is about to read.
    """
    if not isinstance(raw, dict):
        raise ValueError("prefs must be an object")
    if isinstance(raw.get("custom_presets"), list) and \
            len(raw["custom_presets"]) > MAX_CUSTOM_PRESETS:
        raise ValueError(f"At most {MAX_CUSTOM_PRESETS} custom presets are supported")

    merged = {**load_prefs(), **_clean(raw)}
    f = prefs_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(merged, indent=2), encoding="utf-8")
    tmp.replace(f)
    return merged
