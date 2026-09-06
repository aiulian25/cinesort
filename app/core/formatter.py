"""
Template formatter — ported from FileBot's ExpressionFormat / MediaBindingBean.
Provides {n}, {s}, {e}, {t}, {y}, etc. template variables for naming.
"""

import re
from pathlib import Path
from typing import Optional, Any


# Default templates (matching FileBot's defaults)
TEMPLATES = {
    "series": "{n}/Season {s}/{n} - {s00e00} - {t}",
    "movie": "{n} ({y})/{n} ({y})",
    "music": "{artist}/{album}/{track} - {title}",
    "anime": "{n}/{n} - {absolute} - {t}",
}


def _pad(value: Any, width: int = 2) -> str:
    """Zero-pad a number."""
    if value is None:
        return ""
    return str(int(value)).zfill(width)


def format_sxe(season: Optional[int], episode: Optional[int], episode_end: Optional[int] = None) -> str:
    """Format S00E00 style string."""
    if season is None and episode is None:
        return ""
    s = _pad(season) if season is not None else "00"
    e = _pad(episode) if episode is not None else "00"
    result = f"S{s}E{e}"
    if episode_end is not None and episode_end != episode:
        result += f"-E{_pad(episode_end)}"
    return result


# ── The token reference ───────────────────────────────────────────────────
# ONE table, three consumers: GET /api/tokens (which the Settings palette
# renders), tools/gen_token_table.py (which writes the README table), and
# unknown_tokens() below. Three hand-maintained lists is how {e00} came to
# work but be undocumented, and how {quality} came to be documented in the UI
# and nowhere else.
#
# `kind` says where a token has a value: "all" everywhere, "series"/"movie"
# for their own matches, "video" for both but not music, "music" for audio.
TOKENS: list[dict] = [
    {"name": "{n}", "description": "Series or movie name", "example": "Breaking Bad", "kind": "all"},
    {"name": "{name}", "description": "Series or movie name (same as {n})", "example": "Breaking Bad", "kind": "all"},
    {"name": "{y}", "description": "Year", "example": "2008", "kind": "all"},
    {"name": "{year}", "description": "Year (same as {y})", "example": "2008", "kind": "all"},
    {"name": "{t}", "description": "Episode title, movie title, or track title", "example": "Pilot", "kind": "all"},
    {"name": "{title}", "description": "Same as {t}", "example": "Pilot", "kind": "all"},

    {"name": "{s}", "description": "Season number", "example": "1", "kind": "series"},
    {"name": "{e}", "description": "Episode number", "example": "5", "kind": "series"},
    {"name": "{s00}", "description": "Season number, zero-padded", "example": "01", "kind": "series"},
    {"name": "{e00}", "description": "Episode number, zero-padded", "example": "05", "kind": "series"},
    {"name": "{s00e00}", "description": "S01E05 — range-aware for multi-episode files", "example": "S01E05", "kind": "series"},
    {"name": "{e_end}", "description": "Last episode of a multi-episode file", "example": "6", "kind": "series"},
    {"name": "{absolute}", "description": "Absolute episode number (anime)", "example": "42", "kind": "series"},
    {"name": "{d}", "description": "Air date", "example": "2008-01-20", "kind": "series"},

    {"name": "{source}", "description": "Release source", "example": "WEB-DL", "kind": "video"},
    {"name": "{vf}", "description": "Video format / resolution", "example": "1080p", "kind": "video"},
    {"name": "{quality}", "description": "Same as {vf}", "example": "1080p", "kind": "video"},
    {"name": "{group}", "description": "Release group", "example": "GROUP", "kind": "video"},
    {"name": "{codec}", "description": "Video codec", "example": "x265", "kind": "video"},
    {"name": "{audio}", "description": "Audio codec", "example": "DTS-HD", "kind": "video"},
    {"name": "{edition}", "description": "Edition tag — empty when none", "example": "Extended", "kind": "movie"},
    {"name": "{part}", "description": "Part number of a split release — empty when single", "example": "2", "kind": "movie"},
    {"name": "{partN}", "description": '" - Part 2" for a split release — empty otherwise', "example": " - Part 2", "kind": "movie"},
    {"name": "{collection}", "description": "TMDb franchise name — empty when the film is standalone", "example": "Iron Man Collection", "kind": "movie"},
    {"name": "{collectionN}", "description": "Franchise name plus \"/\" — nests franchise films one folder deeper, standalone films unchanged", "example": "Iron Man Collection/", "kind": "movie"},

    {"name": "{id}", "description": "Database id of the matched record (source-dependent)", "example": "1396", "kind": "all"},
    {"name": "{tmdbid}", "description": "TMDb id — empty unless the match came from TMDb", "example": "1396", "kind": "all"},
    {"name": "{imdbid}", "description": "IMDb id — films via OMDb/TMDb, series via TMDb/TVmaze", "example": "tt0903747", "kind": "all"},

    {"name": "{artist}", "description": "Track artist", "example": "Radiohead", "kind": "music"},
    {"name": "{album}", "description": "Album title", "example": "OK Computer", "kind": "music"},
    {"name": "{track}", "description": "Track number, zero-padded", "example": "03", "kind": "music"},
]

KNOWN_TOKENS = frozenset(t["name"] for t in TOKENS)

_TOKEN_RE = re.compile(r'\{(\w+)\}')


def unknown_tokens(template: str) -> list[str]:
    """Token names in `template` that resolve to nothing.

    apply_template leaves an unrecognised {episode} in the output as literal
    text, which reads as a formatter bug rather than a typo. Naming them lets
    the live preview say so.
    """
    return [name for name in _TOKEN_RE.findall(template or "")
            if "{" + name + "}" not in KNOWN_TOKENS]


def apply_template(template: str, bindings: dict[str, Any]) -> str:
    """Apply a naming template with {variable} placeholders.

    See TOKENS above for the complete list — it is the single source the API,
    the Settings palette and the README table all read.
    """

    # Pre-compute derived bindings
    season = bindings.get("s")
    episode = bindings.get("e")
    episode_end = bindings.get("e_end")

    derived = {
        "s00": _pad(season),
        "e00": _pad(episode),
        "s00e00": format_sxe(season, episode, episode_end),
    }

    all_bindings = {**bindings, **derived}

    # Friendly token aliases (flat-UI redesign): {name} {year} {title} {quality}
    # resolve to the short canonical bindings, so both spellings work in any
    # template. Resolved here — the single formatting path shared by matching,
    # live preview, and every build target — never per-endpoint.
    for alias, key in (("name", "n"), ("year", "y"), ("title", "t"), ("quality", "vf")):
        if alias not in all_bindings:
            all_bindings[alias] = all_bindings.get(key)

    def replacer(m: re.Match) -> str:
        key = m.group(1)
        val = all_bindings.get(key)
        if val is None or val == "":
            return ""
        return str(val)

    result = re.sub(r'\{(\w+)\}', replacer, template)

    # Clean up double separators from empty bindings. Jellyfin/Plex id hints
    # first: "[imdbid-{imdbid}]" with an empty id leaves "[imdbid-]" — a
    # dangling prefix, removed by NAME so a filled "[BluRay-…]"-style bracket
    # a user typed can never be swallowed. Then generic empty pairs:
    # "{n} ({y}) [{edition}]" with no edition must not leave "[]".
    result = re.sub(r'\[(?:imdbid|tmdbid)-\]', '', result, flags=re.IGNORECASE)
    result = re.sub(r'\[\s*\]', '', result)
    result = re.sub(r'\(\s*\)', '', result)
    result = re.sub(r'  +', ' ', result)
    result = re.sub(r'- -', '-', result)
    result = re.sub(r'/+', '/', result)
    result = result.strip(' -/')

    return result


def sanitize_filename(name: str) -> str:
    """Remove characters not allowed in filenames."""
    # Replace problematic characters
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    # Replace control characters
    name = re.sub(r'[\x00-\x1f]', '', name)
    # Collapse whitespace
    name = re.sub(r'\s+', ' ', name)
    # Trim dots and spaces from ends (Windows compat)
    name = name.strip('. ')
    return name


# Per-component filename limit on every Linux filesystem CineSort targets
# (ext4, xfs, btrfs, and the FUSE/SMB mounts NAS users point it at). The limit
# is BYTES, not characters — a 200-character CJK title is ~600 bytes and fails
# a rename the UI happily previewed.
MAX_NAME_BYTES = 255


def truncate_component(name: str, reserve: int = 0) -> str:
    """Trim one path component to MAX_NAME_BYTES - reserve UTF-8 bytes.

    Never splits a character (the tail of a partially-sliced multi-byte
    sequence is dropped), and re-trims trailing dots/spaces that the cut can
    expose — sanitize_filename already removed them once, but slicing can
    leave a new one behind. `reserve` covers a suffix the caller appends,
    i.e. the file extension.
    """
    budget = max(0, MAX_NAME_BYTES - reserve)
    raw = name.encode("utf-8")
    if len(raw) <= budget:
        return name
    return raw[:budget].decode("utf-8", errors="ignore").rstrip(". ")


def build_new_path(
    original: Path,
    template: str,
    bindings: dict[str, Any],
    output_dir: Optional[Path] = None,
) -> Path:
    """Build the full new file path from a template and bindings."""
    formatted = apply_template(template, bindings)

    # Sanitize each path component
    parts = formatted.split("/")
    parts = [sanitize_filename(p) for p in parts if p]

    # Keep original extension
    ext = original.suffix

    # Enforce the filesystem's per-component byte limit HERE — the single
    # point every producer flows through (interactive match, live preview,
    # dry run, watch-folder runs). Doing it at build time means the name the
    # UI shows is the name that will actually be written; the previous
    # behavior previewed a name, reported dry-run success, then failed the
    # real rename with a raw [Errno 36].
    # Directory components are truncated too: a long {n} folder would fail
    # mkdir with the same error.
    if parts:
        parts[:-1] = [truncate_component(p) for p in parts[:-1]]
        parts[-1] = truncate_component(parts[-1], reserve=len(ext.encode("utf-8"))) + ext

    base = output_dir if output_dir else original.parent
    return base.joinpath(*parts)
