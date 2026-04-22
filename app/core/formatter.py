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


def apply_template(template: str, bindings: dict[str, Any]) -> str:
    """Apply a naming template with {variable} placeholders.
    Supports FileBot-style variables:
      {n}       - series/movie name
      {y}       - year
      {s}       - season number
      {e}       - episode number
      {s00}     - zero-padded season
      {e00}     - zero-padded episode
      {s00e00}  - formatted SxE
      {t}       - episode/movie title
      {absolute}- absolute episode number
      {d}       - air date
      {source}  - video source
      {vf}      - video format
      {group}   - release group
      {id}      - database ID
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

    def replacer(m: re.Match) -> str:
        key = m.group(1)
        val = all_bindings.get(key)
        if val is None or val == "":
            return ""
        return str(val)

    result = re.sub(r'\{(\w+)\}', replacer, template)

    # Clean up double separators from empty bindings
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

    # Last part gets the extension
    if parts:
        parts[-1] = parts[-1] + ext

    base = output_dir if output_dir else original.parent
    return base.joinpath(*parts)
