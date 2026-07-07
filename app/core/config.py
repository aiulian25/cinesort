"""
CineSort user configuration — API keys for desktop (deb/AppImage) installs.

Storage location (XDG-compliant):
  ~/.config/cinesort/keys.env      ← Linux desktop standard

Format: one KEY=value per line, # comments ignored.
The file is written with mode 0o600 (owner read/write only) so keys
are never world-readable.

Docker users: set keys via environment variables in docker-compose.yml —
this file is never created in a container context.

Priority (highest → lowest):
  1. Environment variable already present in os.environ (e.g. from Docker/systemd)
  2. Value from this file
"""

import os
import re
import stat
from pathlib import Path


# ── Config file location ───────────────────────────────────────────────────────
def _config_dir() -> Path:
    """Return the config directory for CineSort.

    CINESORT_DATA_DIR takes priority (the Docker image sets it to /data, a
    persistent volume) so keys saved from the Settings UI survive container
    recreation. When unset (deb/AppImage/dev), the XDG-compliant per-user
    location is used — identical to the historical behavior.
    """
    dd = os.environ.get("CINESORT_DATA_DIR")
    if dd:
        return Path(dd) / "config"
    xdg = os.environ.get("XDG_CONFIG_HOME", "")
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "cinesort"


def config_file() -> Path:
    return _config_dir() / "keys.env"


# ── Keys we manage ─────────────────────────────────────────────────────────────
MANAGED_KEYS = ("TMDB_API_KEY", "OMDB_API_KEY", "TMDB_LANGUAGE")

# Simple validation: printable ASCII, no whitespace, reasonable length.
# Prevents storing obviously bogus or injection-risky values.
_KEY_RE = re.compile(r'^[\x21-\x7E]{8,256}$')

# TMDB_LANGUAGE is an ISO code ("de" or "de-DE"), far shorter than an API key.
_LANG_RE = re.compile(r'^[a-z]{2}(-[A-Z]{2})?$')


def _validate_for(key: str, value: str) -> bool:
    """Per-key validation rule (API keys vs. the short language code)."""
    if key == "TMDB_LANGUAGE":
        return bool(_LANG_RE.fullmatch(value))
    return bool(_KEY_RE.match(value))


def _validate_key(value: str) -> bool:
    # Kept for backward compatibility; API-key rule only.
    return bool(_KEY_RE.match(value))


# ── Load ───────────────────────────────────────────────────────────────────────
def load_config() -> None:
    """
    Parse keys.env and inject any key that is NOT already present in
    os.environ.  Existing env vars (e.g. Docker compose) always win.
    Called once at application startup in main.py.
    """
    cfg = config_file()
    if not cfg.is_file():
        return

    try:
        text = cfg.read_text(encoding="utf-8")
    except OSError:
        return

    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, raw_value = line.partition("=")
        key = key.strip()
        value = raw_value.strip()
        # Only inject into os.environ if the key is one we own AND not already set
        if key in MANAGED_KEYS and key not in os.environ and value:
            os.environ[key] = value


# ── Save ───────────────────────────────────────────────────────────────────────
def save_config(updates: dict[str, str]) -> None:
    """
    Persist new key values to keys.env, merging with any existing entries.
    Empty-string values remove the key from the file (and from os.environ).
    Values that fail validation are silently skipped.
    The file is always written with mode 0o600.
    """
    cfg = config_file()
    cfg.parent.mkdir(parents=True, exist_ok=True)

    # Read existing entries so we don't lose keys we don't manage
    existing: dict[str, str] = {}
    if cfg.is_file():
        for line in cfg.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, _, v = line.partition("=")
                existing[k.strip()] = v.strip()

    # Apply updates
    for key, value in updates.items():
        if key not in MANAGED_KEYS:
            continue   # refuse to write arbitrary keys
        value = value.strip()
        if value == "":
            existing.pop(key, None)
            os.environ.pop(key, None)
        elif _validate_for(key, value):
            existing[key] = value
            os.environ[key] = value   # hot-reload for current process
        # else: invalid value — silently skip (caller should validate UI-side too)

    # Write atomically: write → chmod → rename
    tmp = cfg.with_suffix(".env.tmp")
    lines = [
        "# CineSort API keys — managed by the app Settings panel.\n",
        "# Do not share this file. Permissions are 0600 (owner-only).\n",
        "#\n",
    ]
    for k, v in existing.items():
        lines.append(f"{k}={v}\n")

    tmp.write_text("".join(lines), encoding="utf-8")
    tmp.chmod(stat.S_IRUSR | stat.S_IWUSR)   # 0o600
    tmp.replace(cfg)                          # atomic rename


# ── Read (masked) ──────────────────────────────────────────────────────────────
def read_config_status() -> dict[str, bool]:
    """
    Return which keys are currently active (set in os.environ).
    Never returns the actual key values.
    """
    return {key: bool(os.environ.get(key)) for key in MANAGED_KEYS}
