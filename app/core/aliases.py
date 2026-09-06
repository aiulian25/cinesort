"""Remembered matches — "this title means that record".

Persisted as aliases.json beside watches.json and keys.env via the same
config-dir abstraction (config.py): /data/config in Docker (survives container
recreation on the /data volume), ~/.config/cinesort on desktop. Written
atomically with the tmp+rename pattern save_config uses.

Why this exists: the watch-folder log has always promised "match it once
manually, then rename stays automatic", but nothing persisted the pick — the
next cycle asked again, forever. An alias is the memory that promise needs.

Keyed on the NORMALIZED clean name (matcher.normalize), so the key a match
looks up is the same one a pick wrote regardless of punctuation, case or
accents. Values are shape-checked on load: a hand-edited or truncated file
degrades to "no aliases", never a crash mid-match.

Aliases hold no filesystem paths and grant no capability — they only pre-answer
a question the user was going to be asked anyway.
"""

import json
from datetime import datetime
from pathlib import Path
from typing import Optional

from app.core.config import config_file
from app.core.matcher import normalize

ALIAS_MEDIA = {"series", "movie"}
# Films exist on TMDb and OMDb; TVmaze is television only, so a movie alias
# pointing at it could never be fetched back.
ALIAS_SOURCES = {"series": {"tmdb", "tvmaze"}, "movie": {"tmdb", "omdb"}}

# FIFO cap, same reasoning as the history file: a bounded file cannot grow
# without limit from a client that keeps picking.
MAX_ALIASES = 500

MAX_NAME_LENGTH = 300


def aliases_file() -> Path:
    return config_file().parent / "aliases.json"


def alias_key(clean_name: str) -> str:
    """The lookup key for a detected title. Empty when there is nothing to key
    on — callers must treat that as "no alias possible".

    matcher.normalize folds case and accents and turns punctuation into
    separators; the separators are then dropped entirely, because the two sides
    here are two different FILENAMES for the same show. Without that last step
    a pick made on "Marvel's Daredevil" would not be found by the next release
    that spells it "Marvels Daredevil" — the one thing this key exists to do.
    """
    return normalize(clean_name or "").replace(" ", "")


def _clean(entry) -> Optional[dict]:
    """Normalized alias dict, or None when the entry is unusable."""
    if not isinstance(entry, dict):
        return None
    media = entry.get("media")
    datasource = entry.get("datasource")
    name = entry.get("name")
    identifier = entry.get("id")

    if media not in ALIAS_MEDIA:
        return None
    if datasource not in ALIAS_SOURCES[media]:
        return None
    if not isinstance(name, str) or not name.strip():
        return None
    if not isinstance(identifier, (int, str)) or not str(identifier).strip():
        return None

    year = entry.get("year")
    if not isinstance(year, int):
        year = None

    return {
        "media": media,
        "datasource": datasource,
        "id": identifier,
        "name": name.strip()[:MAX_NAME_LENGTH],
        "year": year,
        "saved": str(entry.get("saved") or "")[:32],
    }


def load_aliases() -> dict:
    f = aliases_file()
    if not f.is_file():
        return {}
    try:
        raw = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return {}   # malformed file degrades to no aliases, never a crash
    if not isinstance(raw, dict):
        return {}
    out = {}
    for key, entry in list(raw.items())[:MAX_ALIASES]:
        cleaned = _clean(entry)
        if key and cleaned:
            out[str(key)] = cleaned
    return out


def _write(aliases: dict) -> None:
    f = aliases_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(aliases, indent=2), encoding="utf-8")
    tmp.replace(f)


def save_alias(clean_name: str, entry: dict) -> Optional[dict]:
    """Remember `clean_name → entry`. Returns the stored entry, or None when
    the name or the entry is unusable (callers ignore the failure: not
    remembering a pick is a missed convenience, never an error)."""
    key = alias_key(clean_name)
    cleaned = _clean(entry)
    if not key or not cleaned:
        return None
    cleaned["saved"] = datetime.now().isoformat(timespec="seconds")

    aliases = load_aliases()
    aliases.pop(key, None)          # re-insert at the end: newest last
    aliases[key] = cleaned
    while len(aliases) > MAX_ALIASES:
        aliases.pop(next(iter(aliases)))
    _write(aliases)
    return cleaned


def forget_alias(key: str) -> bool:
    """Drop one alias by its key. True when something was removed."""
    aliases = load_aliases()
    if key not in aliases:
        return False
    del aliases[key]
    _write(aliases)
    return True
