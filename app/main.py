"""
Media Renamer — FastAPI backend.
Serves the web UI and provides API endpoints for scanning, matching, and renaming.
"""

import sys

# Enforce minimum Python version before any other import.
# list[str] / dict[str, x] built-in generics (PEP 585) require 3.9+.
# pydantic v2 requires 3.8+; fastapi ≥ 0.100 requires 3.8+.
# We gate at 3.9 because that is the tightest real constraint in this codebase.
if sys.version_info < (3, 9):
    sys.exit(
        f"CineSort requires Python 3.9 or later.\n"
        f"Running under Python {sys.version}.\n"
        f"Please install Python 3.9+ or rebuild the application venv."
    )

import os
import re
import time
import asyncio

import httpx
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

from app.core.detector import (
    detect, MediaType, is_video_file, is_subtitle_file,
    VIDEO_EXTENSIONS, SUBTITLE_EXTENSIONS, AUDIO_EXTENSIONS,
    extract_subtitle_lang_tag,
)
from app.core.matcher import cascade_score, cascade_breakdown, name_similarity, METRIC_LABELS
from app.core.formatter import apply_template, build_new_path, TEMPLATES, sanitize_filename
from app.core.renamer import execute_rename, RenameAction, RenameResult
from app.core.history import history, HistoryEntry
from app.core.config import load_config, save_config, read_config_status, config_file
from app.api.tmdb import TMDbClient
from app.api.tvmaze import TVMazeClient
from app.api.omdb import OMDbClient
from app.api.musicbrainz import MusicBrainzClient
from app.api.retry import with_retry
from app.core.cache import cached, provider_cache
from datetime import datetime, timedelta
import uuid

# ── Load user config (deb/AppImage: ~/.config/cinesort/keys.env) ─────────────
# Must happen BEFORE API clients are instantiated so os.environ is populated.
# Docker users: their env vars are already set; load_config() won't overwrite them.
load_config()


app = FastAPI(title="CineSort", version="1.3.8")


class NoCacheStaticFiles(StaticFiles):
    """StaticFiles that forces the browser to revalidate every asset.

    Without this, after a `docker build`/upgrade the browser keeps serving the
    previously-cached app.js / style.css, so users run stale code (e.g. an old
    Browse dialog) and think the new build "didn't change anything". `no-cache`
    still allows efficient 304s via ETag/Last-Modified — it just forbids using a
    cached copy without checking with the server first.
    """
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


# Serve static files
STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", NoCacheStaticFiles(directory=str(STATIC_DIR)), name="static")

# API clients (shared instances)
# TMDbClient will read TMDB_API_KEY from environment if set, otherwise uses default
tmdb = TMDbClient()
tvmaze = TVMazeClient()
omdb = OMDbClient()   # reads OMDB_API_KEY env var; disabled (returns []) if not set
mb = MusicBrainzClient()   # keyless; throttled to 1 req/s per MusicBrainz terms

# Live progress snapshot for the current /api/match run, polled by the UI via
# GET /api/match-progress. A single module-level dict is deliberate: the UI
# serializes matches (the Match button is disabled while one runs), so at most
# one match is in flight per instance and no locking is needed.
match_progress = {"active": False, "current": 0, "total": 0, "group": "", "files": 0, "started": 0.0}

# Same pattern for the current /api/rename run (GET /api/rename-progress).
# The Rename button is disabled while a run is in flight, so a single
# snapshot is enough here too. Written from the rename worker thread — safe
# without a lock because each field assignment is GIL-atomic and readers
# only render a transient status line.
rename_progress = {"active": False, "current": 0, "total": 0, "file": ""}


@app.get("/")
async def index():
    # no-cache so the HTML (which references the asset URLs) is always revalidated.
    return FileResponse(
        str(STATIC_DIR / "index.html"),
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/CineSort.png")
async def logo():
    """Serve the app logo."""
    logo_path = Path(__file__).parent / "CineSort.png"
    return FileResponse(str(logo_path))


# ─── Models ────────────────────────────────────────────────────────────

class ScanRequest(BaseModel):
    path: str
    recursive: bool = True

    @field_validator("path")
    @classmethod
    def validate_path(cls, v: str) -> str:
        p = Path(v).expanduser().resolve()
        if not p.exists():
            raise ValueError(f"Path does not exist: {v}")
        return str(p)


class BatchScanRequest(BaseModel):
    paths: list[str]
    recursive: bool = True   # applies to directory entries in `paths`

    @field_validator("paths")
    @classmethod
    def validate_paths(cls, v: list[str]) -> list[str]:
        out = []
        for p in v:
            resolved = Path(p).expanduser().resolve()
            if resolved.exists():
                out.append(str(resolved))
        if not out:
            raise ValueError("No valid paths provided")
        return out


class MatchRequest(BaseModel):
    files: list[dict]
    datasource: str = "tmdb"  # "tmdb" | "tvmaze" | "omdb"
    template: Optional[str] = None
    selected_show_id: Optional[int] = None  # User-selected show ID (bypasses search)
    selected_show_name: Optional[str] = None  # User-selected show name
    include_adult: bool = False  # Pass through to TMDB; OMDb never filters adult content

    @field_validator("datasource")
    @classmethod
    def validate_datasource(cls, v: str) -> str:
        allowed = {"tmdb", "tvmaze", "omdb", "musicbrainz"}
        if v not in allowed:
            raise ValueError(f"datasource must be one of: {allowed}")
        return v


class RenameRequest(BaseModel):
    operations: list[dict]
    action: str = "test"

    @field_validator("action")
    @classmethod
    def validate_action(cls, v: str) -> str:
        valid = {a.value for a in RenameAction}
        if v not in valid:
            raise ValueError(f"Invalid action: {v}. Must be one of: {valid}")
        return v


class SettingsRequest(BaseModel):
    """Keys sent by the Settings modal. Empty string = keep current key unchanged
    (for the language field, empty = clear back to TMDb's default English)."""
    tmdb_key: str = ""
    omdb_key: str = ""
    tmdb_language: str = ""

    @field_validator("tmdb_key", "omdb_key")
    @classmethod
    def validate_key(cls, v: str) -> str:
        import re
        if v == "":
            return v   # empty = "don't change this key"
        if not re.fullmatch(r'[\x21-\x7E]{8,256}', v):
            raise ValueError("API key must be 8-256 printable ASCII characters with no spaces.")
        return v

    @field_validator("tmdb_language")
    @classmethod
    def validate_language(cls, v: str) -> str:
        v = v.strip()
        if v == "":
            return v   # empty = TMDb default (English)
        import re
        if not re.fullmatch(r"[a-z]{2}(-[A-Z]{2})?", v):
            raise ValueError("Language must be an ISO code like 'de' or 'de-DE' (empty = default English).")
        return v


# ─── Scan Endpoint ─────────────────────────────────────────────────────

def _file_entry(p: Path) -> dict:
    """Detection payload for one media file (shared by both scan endpoints)."""
    det = detect(p)
    return {
        "path": str(p),
        "filename": p.name,
        "size": p.stat().st_size,
        "media_type": det.media_type.value,
        "clean_name": det.clean_name,
        "season": det.episode_info.season if det.episode_info else None,
        "episode": det.episode_info.episode if det.episode_info else None,
        "episode_end": det.episode_info.episode_end if det.episode_info else None,
        "absolute": det.episode_info.absolute if det.episode_info else None,
        "date": det.episode_info.date if det.episode_info else None,
        "special": det.episode_info.special if det.episode_info else False,
        "year": det.year,
        "group": det.group,
        "source": det.source,
        "video_format": det.video_format,
        "codec": det.codec,
        "audio": det.audio,
        "edition": det.edition,
        # Music-only fields (None for video/subtitles)
        "artist": det.artist,
        "album": det.album,
        "track": det.track,
        "title": det.title,
    }


# Natural (human numeric) sort for scan listings: "E2" before "E10",
# "Season 2/" before "Season 10/". Keyed on the FULL path — not just the
# filename — so recursive scans keep files grouped by directory exactly like
# the plain sorted() they replace. Splitting on the digit capture group keeps
# int/str positions parity-aligned between any two keys, so mixed-type
# comparisons can never occur.
_NAT_RE = re.compile(r"(\d+)")


def _natural_key(p: Path):
    return [int(t) if t.isdigit() else t.lower() for t in _NAT_RE.split(str(p))]


def _scan_dir_sync(path: str, recursive: bool) -> dict:
    base = Path(path)
    media_exts = VIDEO_EXTENSIONS | SUBTITLE_EXTENSIONS | AUDIO_EXTENSIONS

    if base.is_file():
        paths = [base]
    elif recursive:
        paths = sorted(base.rglob("*"), key=_natural_key)
    else:
        paths = sorted(base.iterdir(), key=_natural_key)

    files = [
        _file_entry(p)
        for p in paths
        if p.is_file() and p.suffix.lower() in media_exts
    ]
    return {"count": len(files), "files": files}


def _scan_batch_sync(path_list: list[str], recursive: bool) -> dict:
    media_exts = VIDEO_EXTENSIONS | SUBTITLE_EXTENSIONS | AUDIO_EXTENSIONS
    files = []
    for path_str in path_list:
        p = Path(path_str)
        if p.is_dir():
            targets = (
                sorted(p.rglob("*"), key=_natural_key)
                if recursive
                else sorted(p.iterdir(), key=_natural_key)
            )
        else:
            targets = [p]
        files.extend(
            _file_entry(t)
            for t in targets
            if t.is_file() and t.suffix.lower() in media_exts
        )
    return {"count": len(files), "files": files}


@app.post("/api/scan")
async def scan_directory(req: ScanRequest):
    """Scan a directory for media files and auto-detect metadata.

    The filesystem walk runs in a worker thread: on slow storage (NAS/SMB) a
    large recursive walk takes minutes, and doing it on the event loop froze
    the entire app — every request, for every user — until it finished.
    """
    return await asyncio.to_thread(_scan_dir_sync, req.path, req.recursive)


@app.post("/api/scan-batch")
async def scan_batch(req: BatchScanRequest):
    """Scan a list of file/folder paths for media files.

    Runs off the event loop (see scan_directory) and honors `recursive` for
    directory entries — previously it always crawled the full tree, ignoring
    the UI's "Include subfolders" toggle.
    """
    return await asyncio.to_thread(_scan_batch_sync, req.paths, req.recursive)


# ─── Browse Endpoint ───────────────────────────────────────────────────

def browse_roots() -> list[Path]:
    """Directories the server-side HTML file browser is allowed to expose.

    Default (Docker / server): mounted volumes only — /mnt and /media — so a
    network-exposed instance can never be walked outside its mounts.

    Admins can extend the list via the CINESORT_BROWSE_ROOTS environment
    variable (os.pathsep-separated, e.g. "/srv/media:/data/tv"). This is a
    deployment-layer setting controlled by whoever runs the container/host,
    never by the end user, so it does not weaken the security boundary.

    Note: desktop builds (deb/AppImage) use the native OS picker instead of this
    browser, so they reach $HOME and any mount through OS permissions without
    needing this allow-list widened.
    """
    roots = [Path("/mnt"), Path("/media")]
    extra = os.environ.get("CINESORT_BROWSE_ROOTS", "")
    for part in extra.split(os.pathsep):
        part = part.strip()
        if part:
            roots.append(Path(part))
    # De-duplicate while preserving order
    seen: set[str] = set()
    unique: list[Path] = []
    for r in roots:
        key = str(r)
        if key not in seen:
            seen.add(key)
            unique.append(r)
    return unique


def _within_roots(p: Path, roots: list[Path]) -> bool:
    """True if p is one of the roots or sits inside one of them."""
    return any(p == root or root in p.parents for root in roots)


@app.get("/api/browse-roots")
async def get_browse_roots():
    """Return the browsable roots (quick-access shortcuts) and the default
    starting path for the HTML browser, plus the set of media extensions so the
    front-end can offer a 'media only' filter. Keeps the UI from hardcoding
    paths the backend would reject."""
    roots = browse_roots()
    shortcuts = [
        {"name": r.name or str(r), "path": str(r)}
        for r in roots if r.exists()
    ]
    default_path = shortcuts[0]["path"] if shortcuts else str(roots[0])
    return {
        "default_path": default_path,
        "shortcuts": shortcuts,
        "media_extensions": sorted(VIDEO_EXTENSIONS | SUBTITLE_EXTENSIONS),
    }


@app.get("/api/browse")
async def browse_directory(path: str = Query("")):
    """Browse directories on the server. Returns list of subdirectories and files."""
    try:
        roots = browse_roots()
        default_root = next((r for r in roots if r.exists()), roots[0])

        # resolve() also collapses symlinks, so a symlink pointing outside the
        # allowed roots resolves to its real target and is rejected below.
        p = Path(path).resolve() if path else default_root

        # Security: only allow browsing within the configured roots
        if not _within_roots(p, roots):
            p = default_root

        if not p.exists():
            raise HTTPException(status_code=404, detail=f"Path does not exist: {path}")

        if not p.is_dir():
            raise HTTPException(status_code=400, detail=f"Path is not a directory: {path}")

        items = []

        # Add parent directory link — unless p is itself a root (don't escape upward)
        is_root = any(p == r for r in roots)
        if not is_root and _within_roots(p.parent, roots):
            items.append({
                "name": "..",
                "path": str(p.parent),
                "type": "parent",
                "size": None,
            })

        # List directories and files
        try:
            for item in sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
                try:
                    stat = item.stat()
                    items.append({
                        "name": item.name,
                        "path": str(item),
                        "type": "directory" if item.is_dir() else "file",
                        "size": stat.st_size if item.is_file() else None,
                        "modified": stat.st_mtime,
                    })
                except (PermissionError, OSError):
                    # Skip items we can't access
                    continue
        except PermissionError:
            raise HTTPException(status_code=403, detail=f"Permission denied: {path}")
        
        return {
            "path": str(p),
            "items": items,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── Search Endpoint ───────────────────────────────────────────────────

@app.get("/api/search")
async def search_metadata(
    q: str = Query(..., min_length=1),
    type: str = Query("tv", pattern="^(tv|movie)$"),
    datasource: str = Query("tmdb", pattern="^(tmdb|tvmaze|omdb)$"),
    year: Optional[int] = None,
    include_adult: bool = Query(False),
    # Plain None (not Query(None)): the Query sentinel is truthy when this
    # coroutine is called directly (tests, future CLI), which would wrongly
    # take the imdb_id branch. FastAPI treats both identically over HTTP;
    # format validation lives in omdb.get_by_imdb_id().
    imdb_id: Optional[str] = None,
):
    """Search for TV shows or movies by name — or by exact IMDb tt-ID.

    When `imdb_id` is provided it takes precedence over the text query and
    returns at most one exact OMDb result (the client validates the tt-ID
    format and raises ValueError on garbage → 400 here)."""
    results = []

    if imdb_id:
        if not omdb.enabled:
            raise HTTPException(
                status_code=503,
                detail="IMDb-ID lookup needs an OMDb key. Add it in Settings.",
            )
        try:
            r = await omdb.get_by_imdb_id(imdb_id.strip())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if r:
            results.append({
                "id": r.imdb_id,
                "title": r.title,
                "year": r.year,
                "overview": r.overview[:200] if r.overview else "",
                "poster": r.poster_url,
                "type": r.media_type,
                "rating": r.imdb_rating,
                "datasource": "omdb",
            })
        return {"results": results}

    if datasource == "tmdb":
        if type == "tv":
            raw = await tmdb.search_tv(q, year)
        else:
            raw = await tmdb.search_movie(q, year, include_adult=include_adult)
        for r in raw[:10]:
            results.append({
                "id": r.id,
                "title": r.title,
                "year": r.year,
                "overview": r.overview[:200] if r.overview else "",
                "poster": r.poster_url_small,
                "type": r.media_type,
                "rating": r.vote_average,
                "datasource": "tmdb",
            })
    elif datasource == "tvmaze":
        if type == "tv":
            raw = await tvmaze.search_shows(q)
            for r in raw[:10]:
                results.append({
                    "id": r.id,
                    "title": r.name,
                    "year": r.year,
                    "overview": r.summary[:200] if r.summary else "",
                    "poster": r.image_url,
                    "type": "tv",
                    "rating": None,
                    "datasource": "tvmaze",
                })
    elif datasource == "omdb":
        if omdb.enabled:
            raw = await omdb.search_movie(q, year)
            for r in raw[:10]:
                results.append({
                    "id": r.imdb_id,   # string tt-ID, not an int
                    "title": r.title,
                    "year": r.year,
                    "overview": r.overview[:200] if r.overview else "",
                    "poster": r.poster_url,
                    "type": "movie",
                    "rating": r.imdb_rating,
                    "datasource": "omdb",
                })
        else:
            raise HTTPException(
                status_code=503,
                detail="OMDb is not configured. Set the OMDB_API_KEY environment variable."
            )

    return {"results": results}


# ─── Matching helpers ──────────────────────────────────────────────────

# Confidence thresholds — SINGLE source of truth for every build target.
# The frontend fetches both from GET /api/settings at startup instead of
# hardcoding its own copies, so Docker/deb/rpm/AppImage can never drift.
#   low:    at/below this a match is never auto-selected for renaming.
#   review: below this a match shows the "needs review" triangle and counts
#           toward the footer's "Review N matches".
# Deployment-layer overrides (same pattern as CINESORT_BROWSE_ROOTS):
# CINESORT_LOW_CONFIDENCE / CINESORT_REVIEW_CONFIDENCE, clamped to [0, 1];
# unparseable values fall back to the defaults.
def _threshold_env(name: str, default: float) -> float:
    try:
        v = float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default
    return max(0.0, min(1.0, v))


LOW_CONFIDENCE_THRESHOLD = _threshold_env("CINESORT_LOW_CONFIDENCE", 0.4)
REVIEW_CONFIDENCE_THRESHOLD = _threshold_env("CINESORT_REVIEW_CONFIDENCE", 0.6)


def _query_variants(name: str, year: Optional[int]) -> list[tuple[str, Optional[int]]]:
    """Progressively-trimmed search queries, most specific first.

    Detection sometimes leaves release-group noise or stray tokens in the
    cleaned name, so a single exact query can miss. We try the full name (with
    year), then without the year, then drop trailing tokens one at a time.
    """
    name = (name or "").strip()
    variants: list[tuple[str, Optional[int]]] = []
    seen: set[tuple[str, Optional[int]]] = set()

    def add(q: str, y: Optional[int]) -> None:
        q = q.strip()
        key = (q.lower(), y)
        if q and key not in seen:
            seen.add(key)
            variants.append((q, y))

    if year:
        add(name, year)
    add(name, None)

    tokens = name.split()
    for cut in range(len(tokens) - 1, 0, -1):
        add(" ".join(tokens[:cut]), None)

    return variants


# API keys travel as URL query params (?api_key=… / ?apikey=…), and httpx
# error strings embed the full request URL. Redact before any error text can
# reach the UI/status bar — a 401 message must never leak the key itself.
_KEY_PARAM_RE = re.compile(r'(api_?key=)[^&\s\'\"]+', re.IGNORECASE)


def _sanitize_error(exc: Exception) -> str:
    """One-line, UI-safe error string: type + message with key params redacted,
    first line only (httpx appends an MDN help link on a second line), capped."""
    msg = f"{type(exc).__name__}: {exc}".splitlines()[0]
    msg = _KEY_PARAM_RE.sub(r"\1***", msg)
    return msg[:200]


async def _cascade_search(search_coro, query: str, year: Optional[int]):
    """Return `(results, errors)` — the first non-empty result set across the
    trimmed query variants, plus every failure encountered on the way.

    `search_coro(q, y)` is an async callable returning a list. A failure on one
    variant (network blip, source error) is swallowed so the next variant can
    still succeed and one flaky source never aborts the whole match — but the
    sanitized error is collected so match_files() can tell the user WHY nothing
    matched (revoked key, network down) instead of a bare "No match found"."""
    errors: list[str] = []
    for q, y in _query_variants(query, year):
        try:
            # One transparent retry for rate limits / timeouts (retry.py) —
            # a single blip no longer burns this variant.
            results = await with_retry(lambda: search_coro(q, y))
        except Exception as exc:   # pragma: no cover - defensive
            # Sanitized in the log too — docker logs get shared in bug reports.
            print(f"[WARN] search failed for {q!r}: {_sanitize_error(exc)}")
            errors.append(_sanitize_error(exc))
            results = []
        if results:
            return results, errors
    return [], errors


def _disambiguate_by_year(shows: list, year: Optional[int]) -> list:
    """If several same-named shows come back but the filename carries a year,
    prefer the single candidate whose year matches — avoids a needless prompt.
    Falls back to the full list when 0 or >1 candidates match."""
    if not year or len(shows) <= 1:
        return shows
    matches = [s for s in shows if getattr(s, "year", None) == year]
    return matches if len(matches) == 1 else shows


def _index_episodes(episodes_data: list[dict]) -> tuple[dict, dict, dict]:
    """Assign absolute episode numbers (cumulative across seasons, skipping
    season-0 specials) and build fast lookup indexes:
      (season, episode) -> episode dict
      absolute          -> episode dict
      air_date (YYYY-MM-DD) -> episode dict
    This makes exact matches O(1): SxE, absolute (anime), and air-date (daily
    shows — files like Show.2024.03.05.mkv previously never matched because
    nothing compared the detected date against episode air dates)."""
    regular = sorted(
        (e for e in episodes_data if e.get("season")),   # season truthy → not 0/None
        key=lambda e: (e.get("season") or 0, e.get("episode") or 0),
    )
    for i, ep in enumerate(regular, start=1):
        ep["absolute"] = i

    se_index = {
        (e.get("season"), e.get("episode")): e
        for e in episodes_data
        if e.get("season") is not None and e.get("episode") is not None
    }
    abs_index = {e["absolute"]: e for e in regular}
    date_index = {e["air_date"]: e for e in episodes_data if e.get("air_date")}
    return se_index, abs_index, date_index


def _adjacent_date_episode(file_date, date_index: dict):
    """Episode airing one day before/after `file_date`, or None.

    Daily-show files are stamped with the LOCAL broadcast date, routinely one
    day off the provider's air date across timezones. The day BEFORE is
    probed first: the common case is a file dated one day AFTER the listed
    air date (late-night broadcasts crossing midnight, viewers east of the
    studio), so when a daily show has episodes on both neighboring days the
    previous day is the better prior. The detector guarantees YYYY-MM-DD via
    DATE_PATTERN, but parse defensively anyway."""
    if not file_date or not date_index:
        return None
    try:
        d = datetime.strptime(file_date, "%Y-%m-%d")
    except (TypeError, ValueError):
        return None
    for delta in (-1, 1):
        hit = date_index.get((d + timedelta(days=delta)).strftime("%Y-%m-%d"))
        if hit is not None:
            return hit
    return None


async def _find_series(datasource: str, group_name: str, year, source_errors: dict):
    """Search ONE TV source for a series and download its episode list.

    Pure extraction of the former per-source search blocks so the caller can
    retry the OTHER source when this one comes up empty (series fallback).

    Returns (show_data, episodes_data, failed_seasons, episodes_fetch_error,
    needs_selection). `needs_selection` is the multi-candidate payload for
    the disambiguation dialog — the caller only honors it from the PRIMARY
    source: show ids are source-specific, and the follow-up request would
    query req.datasource with them, so a fallback-source prompt would wire
    the wrong id to the wrong provider.
    """
    show_data = None
    episodes_data: list = []
    failed_seasons: dict[int, str] = {}
    episodes_fetch_error: Optional[str] = None

    if datasource == "tvmaze":
        # TVmaze search has no year filter, so we only vary the query.
        shows, errs = await _cascade_search(
            lambda q, _y: cached(("tvmaze", "search", q),
                                 lambda: tvmaze.search_shows(q)), group_name, None
        )
        if errs:
            source_errors.setdefault("tvmaze", errs[0])
        shows = _disambiguate_by_year(shows, year)
        if len(shows) > 1:
            return None, [], {}, None, {
                "needs_selection": True,
                "group_name": group_name,
                "candidates": [
                    # status + genres: the fields that actually distinguish
                    # same-named reboots ("Ended · Drama" vs "Running · …").
                    {"id": s.id, "name": s.name, "year": s.year, "poster": s.image_url,
                     "overview": s.summary[:200] if s.summary else "",
                     "status": s.status, "genres": (s.genres or [])[:3]}
                    for s in shows[:10]
                ],
            }
        elif shows:
            show = shows[0]
            show_data = {"id": show.id, "name": show.name, "year": show.year, "poster": show.image_url}
            try:
                eps = await cached(
                    ("tvmaze", "episodes", show.id),
                    lambda: with_retry(lambda: tvmaze.get_episodes(show.id)))
            except Exception as exc:
                episodes_fetch_error = _sanitize_error(exc)
                eps = []
            episodes_data = [
                {"season": e.season, "episode": e.episode, "title": e.title, "air_date": e.air_date}
                for e in eps
            ]
    else:
        shows, errs = await _cascade_search(
            lambda q, y: cached(("tmdb", "search_tv", q, y),
                                lambda: tmdb.search_tv(q, y)), group_name, year
        )
        if errs:
            source_errors.setdefault("tmdb", errs[0])
        shows = _disambiguate_by_year(shows, year)
        if len(shows) > 1:
            return None, [], {}, None, {
                "needs_selection": True,
                "group_name": group_name,
                "candidates": [
                    # TMDb search results carry no status/genre names — empty
                    # fields keep one candidate shape without extra API calls.
                    {"id": s.id, "name": s.title, "year": s.year, "poster": s.poster_url_small,
                     "overview": s.overview[:200] if s.overview else "",
                     "rating": s.vote_average, "status": "", "genres": []}
                    for s in shows[:10]
                ],
            }
        elif shows:
            show = shows[0]
            show_data = {"id": show.id, "name": show.title, "year": show.year, "poster": show.poster_url_small}
            # Fetch all seasons
            details = await cached(
                ("tmdb", "details", show.id),
                lambda: with_retry(lambda: tmdb.get_tv_details(show.id)))
            seasons = details.get("seasons", [])
            for s in seasons:
                sn = s.get("season_number", 0)
                try:
                    eps = await cached(
                        ("tmdb", "season", show.id, sn),
                        lambda: with_retry(lambda: tmdb.get_tv_season(show.id, sn)))
                    episodes_data.extend([
                        {"season": e.season, "episode": e.episode, "title": e.title, "air_date": e.air_date}
                        for e in eps
                    ])
                except Exception as exc:
                    failed_seasons[sn] = _sanitize_error(exc)

    return show_data, episodes_data, failed_seasons, episodes_fetch_error, None


# ─── Match Endpoint ────────────────────────────────────────────────────

@app.post("/api/match")
async def match_files(req: MatchRequest):
    """Match scanned files against metadata from TMDb/TVmaze.

    Thin wrapper so the progress snapshot is ALWAYS reset — the impl has an
    early return (needs_selection) and can raise; the finally covers both.
    """
    try:
        return await _match_files_impl(req)
    finally:
        match_progress["active"] = False


@app.get("/api/match-progress")
async def get_match_progress():
    """Live snapshot of the running match (see match_progress above)."""
    return match_progress


@app.get("/api/rename-progress")
async def get_rename_progress():
    """Live snapshot of the running rename (see rename_progress above)."""
    return rename_progress


async def _match_files_impl(req: MatchRequest):
    """Groups files by detected series/movie, looks up metadata, and proposes renames."""

    results = []
    # First sanitized error per datasource — surfaced to the UI so "no match"
    # caused by a revoked key / network outage is distinguishable from a
    # genuine miss. Keys: "tmdb" | "tvmaze" | "omdb".
    source_errors: dict[str, str] = {}

    # Three-way split: subtitles pair with companion videos at the end,
    # music matches per-file against MusicBrainz, everything else is video.
    subtitle_files: list[dict] = []
    music_files: list[dict] = []
    video_files: list[dict] = []
    for f in req.files:
        suffix = Path(f["path"]).suffix.lower()
        if suffix in SUBTITLE_EXTENSIONS:
            subtitle_files.append(f)
        elif f.get("media_type") == "music" or suffix in AUDIO_EXTENSIONS:
            music_files.append(f)
        else:
            video_files.append(f)

    # Group VIDEO files only by detected name
    groups: dict[str, list[dict]] = {}
    for f in video_files:
        key = f.get("clean_name", "unknown")
        groups.setdefault(key, []).append(f)

    # Real progress (replaces the old debug prints): the UI polls
    # /api/match-progress and renders "Matching group X/Y: NAME (N files)…".
    # Each music file counts as its own group (MusicBrainz is 1 req/s, so
    # per-file progress is exactly what makes long audio batches bearable).
    match_progress.update(
        active=True, total=len(groups) + len(music_files), current=0,
        group="", files=0, started=time.time(),
    )

    # ── Music: per-file MusicBrainz recording search ───────────────────────
    if music_files and req.datasource != "musicbrainz":
        for f in music_files:
            match_progress["current"] += 1
            results.append({
                "original": f["path"], "filename": f["filename"],
                "new_path": None, "new_name": None, "preview": None,
                "score": 0, "matched": False, "metadata": None,
                "reason": "Switch Source to MusicBrainz for audio files",
            })
    elif music_files:
        template_music = req.template or TEMPLATES["music"]
        for f in music_files:
            match_progress["current"] += 1
            match_progress["group"] = f.get("clean_name") or f["filename"]
            match_progress["files"] = 1

            try:
                # Cached (15 min) — amortizes MusicBrainz's mandatory 1 req/s
                # throttle across repeated audio matches. Deliberately NOT
                # retried (see retry.py on MusicBrainz policy).
                mb_artist = f.get("artist")
                mb_title = f.get("title") or f.get("clean_name") or ""
                recs = await cached(
                    ("musicbrainz", "recording", mb_artist, mb_title),
                    lambda: mb.search_recording(mb_artist, mb_title),
                )
            except Exception as exc:
                source_errors.setdefault("musicbrainz", _sanitize_error(exc))
                recs = []

            best, best_score, best_ns = None, 0.0, 0.0
            for c in recs:
                # Blend our filename similarity with MusicBrainz's own 0-100
                # relevance: near-ties on similarity are broken by the
                # provider's ranking instead of raw list order. The winner's
                # components are kept so score_detail shows the REAL inputs.
                ns = name_similarity(f.get("clean_name") or "", f"{c.artist} - {c.title}")
                s = 0.7 * ns + 0.3 * ((getattr(c, "score", 0) or 0) / 100.0)
                if s > best_score:
                    best, best_score, best_ns = c, s, ns

            if best:
                # Prefer the track number parsed from the filename — the
                # first-release mapping from MusicBrainz is a weaker guess.
                track = f.get("track") or best.track_no
                bindings = {
                    "artist": best.artist or f.get("artist") or "Unknown Artist",
                    "album": best.album or "Unknown Album",
                    "track": str(track or 0).zfill(2),
                    "title": best.title,
                    "y": best.year or "",
                }
                original = Path(f["path"])
                new_path = build_new_path(original, template_music, bindings, original.parent)
                results.append({
                    "original": f["path"],
                    "filename": f["filename"],
                    "new_path": str(new_path),
                    "new_name": new_path.name,
                    "preview": str(new_path.relative_to(original.parent)),
                    "score": round(best_score, 3),
                    # Same shape as cascade_breakdown()'s components, so the
                    # existing Why-this-match table renders it unchanged.
                    "score_detail": [
                        {"metric": "name", "label": METRIC_LABELS["name"],
                         "value": round(best_ns, 3), "weight": 0.7},
                        {"metric": "mb", "label": METRIC_LABELS["mb"],
                         "value": round((getattr(best, "score", 0) or 0) / 100.0, 3), "weight": 0.3},
                    ],
                    "matched": True,
                    "metadata": {
                        "artist": best.artist,
                        "album": best.album,
                        "title": best.title,
                        "year": best.year,
                    },
                })
            else:
                if "musicbrainz" in source_errors:
                    reason = f"musicbrainz error: {source_errors['musicbrainz']}"
                else:
                    reason = f"No results for '{f.get('clean_name') or f['filename']}'"
                results.append({
                    "original": f["path"], "filename": f["filename"],
                    "new_path": None, "new_name": None, "preview": None,
                    "score": 0, "matched": False, "metadata": None,
                    "reason": reason,
                })

    for group_name, group_files in groups.items():
        match_progress["current"] += 1
        match_progress["group"] = group_name
        match_progress["files"] = len(group_files)

        # Cross-talk guard: the MusicBrainz source only matches audio.
        if req.datasource == "musicbrainz":
            for f in group_files:
                results.append({
                    "original": f["path"], "filename": f["filename"],
                    "new_path": None, "new_name": None, "preview": None,
                    "score": 0, "matched": False, "metadata": None,
                    "reason": "MusicBrainz matches audio files only",
                })
            continue

        sample = group_files[0]
        media_type = sample.get("media_type", "unknown")
        year = sample.get("year")

        # Search for metadata
        show_data = None
        episodes_data = []
        # Truthful failure tracking (per group): seasons whose episode fetch
        # raised, and a whole-list fetch failure (TVmaze single call). Without
        # these, a network blip during season 3 made every S03 file claim
        # "No episode match in 'Show'" — implying the episode doesn't exist.
        failed_seasons: dict[int, str] = {}
        episodes_fetch_error: Optional[str] = None
        # Set when the OTHER TV source was queried after the primary found
        # nothing — drives the "(also tried …)" part of failure reasons.
        fallback_tried: Optional[str] = None

        if media_type == "series":
            # Check if user already selected a specific show
            if req.selected_show_id and req.selected_show_name:
                # Use the pre-selected show
                if req.datasource == "tvmaze":
                    show_details = await cached(
                        ("tvmaze", "show", req.selected_show_id),
                        lambda: with_retry(lambda: tvmaze.get_show(req.selected_show_id)))
                    show_data = {"id": show_details.id, "name": show_details.name, "year": show_details.year, "poster": show_details.image_url}
                    try:
                        eps = await cached(
                            ("tvmaze", "episodes", req.selected_show_id),
                            lambda: with_retry(lambda: tvmaze.get_episodes(req.selected_show_id)))
                    except Exception as exc:
                        episodes_fetch_error = _sanitize_error(exc)
                        eps = []
                    episodes_data = [
                        {"season": e.season, "episode": e.episode, "title": e.title, "air_date": e.air_date}
                        for e in eps
                    ]
                else:
                    show_details = await cached(
                        ("tmdb", "details", req.selected_show_id),
                        lambda: with_retry(lambda: tmdb.get_tv_details(req.selected_show_id)))
                    show_data = {"id": req.selected_show_id, "name": show_details.get("name"), "year": show_details.get("first_air_date", "")[:4] if show_details.get("first_air_date") else None, "poster": f"https://image.tmdb.org/t/p/w154{show_details.get('poster_path')}" if show_details.get("poster_path") else None}
                    seasons = show_details.get("seasons", [])
                    for s in seasons:
                        sn = s.get("season_number", 0)
                        try:
                            eps = await cached(
                                ("tmdb", "season", req.selected_show_id, sn),
                                lambda: with_retry(lambda: tmdb.get_tv_season(req.selected_show_id, sn)))
                            episodes_data.extend([
                                {"season": e.season, "episode": e.episode, "title": e.title, "air_date": e.air_date}
                                for e in eps
                            ])
                        except Exception as exc:
                            failed_seasons[sn] = _sanitize_error(exc)
            else:
                # Search the selected source (progressively-trimmed queries,
                # multi-match check). When it yields NOTHING — zero results or
                # a source error — silently try the other TV source before
                # reporting "No results". The primary source always wins when
                # it returns anything, including the disambiguation prompt;
                # the fallback never second-guesses a found show.
                (show_data, episodes_data, failed_seasons,
                 episodes_fetch_error, needs_sel) = await _find_series(
                    req.datasource, group_name, year, source_errors)
                if needs_sel:
                    return needs_sel

                if show_data is None:
                    other = "tvmaze" if req.datasource == "tmdb" else "tmdb"
                    # tmdb needs a key; tvmaze is keyless and always available.
                    if other == "tvmaze" or tmdb.enabled:
                        fallback_tried = other
                        (fb_show, fb_eps, fb_failed,
                         fb_eps_err, fb_sel) = await _find_series(
                            other, group_name, year, source_errors)
                        # fb_sel (multiple candidates on the fallback source)
                        # is deliberately NOT returned: its show ids belong to
                        # `other`, but a selection re-request would query
                        # req.datasource with them — wrong show guaranteed.
                        if fb_show is not None:
                            fb_show["fallback_source"] = other
                            show_data, episodes_data = fb_show, fb_eps
                            failed_seasons = fb_failed
                            episodes_fetch_error = fb_eps_err

            # Surface fetch failures in the match status line too (first one
            # wins, matching the _cascade_search convention above). Attribute
            # them to the source that actually served this show — the
            # fallback's failures are not the primary's.
            eff_source = (show_data or {}).get("fallback_source") or req.datasource
            if failed_seasons:
                first_sn = sorted(failed_seasons)[0]
                source_errors.setdefault(
                    eff_source,
                    f"season {first_sn} fetch failed: {failed_seasons[first_sn]}",
                )
            if episodes_fetch_error:
                source_errors.setdefault(
                    eff_source, f"episode list fetch failed: {episodes_fetch_error}"
                )

            # Match each file to an episode.
            # Build O(1) lookup indexes once per show and assign absolute numbers
            # so exact SxxExx / absolute matches don't need a full scan+score.
            template = req.template or TEMPLATES["series"]
            se_index, abs_index, date_index = _index_episodes(episodes_data)
            for f in group_files:
                best_ep = None
                best_score = 0
                fs, fe = f.get("season"), f.get("episode")
                fabs = f.get("absolute")

                if fs is not None and fs in failed_seasons:
                    # This file's season never downloaded. Don't let the
                    # cascade fallback "match" it to an episode from another
                    # season at a junk score — fall through unmatched so the
                    # truthful season-failure reason below is what the user
                    # sees.
                    pass
                elif fs is not None and fe is not None and (fs, fe) in se_index:
                    # Exact season/episode hit — no need to score every episode.
                    best_ep = se_index[(fs, fe)]
                    best_score = 1.0
                elif fabs is not None and fabs in abs_index:
                    # Absolute (anime) hit.
                    best_ep = abs_index[fabs]
                    best_score = 0.9
                elif f.get("date") and f["date"] in date_index:
                    # Air-date hit (daily shows: Show.YYYY.MM.DD.mkv).
                    best_ep = date_index[f["date"]]
                    best_score = 0.95
                elif (adj_ep := _adjacent_date_episode(f.get("date"), date_index)) is not None:
                    # Tolerant air-date hit (±1 day, timezone skew). 0.9 keeps
                    # exact dates preferred; the matcher's date metric awards
                    # the same 0.9 so "Why this match" explains it.
                    best_ep = adj_ep
                    best_score = 0.9
                else:
                    for ep in episodes_data:
                        score = cascade_score(
                            file_name=f["clean_name"],
                            file_season=fs,
                            file_episode=fe,
                            file_absolute=fabs,
                            file_year=f.get("year"),
                            meta_name=show_data["name"] if show_data else "",
                            meta_season=ep["season"],
                            meta_episode=ep["episode"],
                            meta_absolute=ep.get("absolute", 0) or 0,
                            meta_year=show_data.get("year") if show_data else None,
                        )
                        if score > best_score:
                            best_score = score
                            best_ep = ep

                if best_ep and show_data:
                    # Per-metric breakdown so the UI can explain the match.
                    score_detail = cascade_breakdown(
                        file_name=f["clean_name"],
                        file_season=fs,
                        file_episode=fe,
                        file_absolute=fabs,
                        file_year=f.get("year"),
                        meta_name=show_data["name"],
                        meta_season=best_ep["season"],
                        meta_episode=best_ep["episode"],
                        meta_absolute=best_ep.get("absolute", 0) or 0,
                        meta_year=show_data.get("year"),
                        file_date=f.get("date"),
                        meta_air_date=best_ep.get("air_date"),
                    )["components"]
                    bindings = {
                        "n": show_data["name"],
                        "y": show_data.get("year", ""),
                        "s": best_ep["season"],
                        "e": best_ep["episode"],
                        "e_end": f.get("episode_end"),
                        "t": best_ep.get("title", ""),
                        "d": best_ep.get("air_date", ""),
                        "source": f.get("source", ""),
                        "vf": f.get("video_format", ""),
                        "group": f.get("group", ""),
                        "codec": f.get("codec") or "",
                        "audio": f.get("audio") or "",
                        "edition": f.get("edition") or "",
                        "id": show_data["id"],
                        # eff_source is F13-aware: after a tmdb→tvmaze
                        # fallback the id is TVmaze-internal and must NOT be
                        # emitted as a tmdbid. TVmaze ids are never imdb/tmdb.
                        "tmdbid": show_data["id"] if eff_source == "tmdb" else "",
                        "imdbid": "",
                    }
                    original = Path(f["path"])
                    new_path = build_new_path(original, template, bindings, original.parent.parent)
                    results.append({
                        "original": f["path"],
                        "filename": f["filename"],
                        "new_path": str(new_path),
                        "new_name": new_path.name,
                        "preview": str(new_path.relative_to(new_path.parents[2]) if len(new_path.parents) > 2 else new_path.name),
                        "score": round(best_score, 3),
                        "score_detail": score_detail,
                        "matched": True,
                        "metadata": {
                            "show": show_data.get("name"),
                            "season": best_ep["season"],
                            "episode": best_ep["episode"],
                            "title": best_ep.get("title"),
                            "poster": show_data.get("poster"),
                            # Which provider actually supplied this show —
                            # differs from req.datasource after a fallback.
                            "datasource": show_data.get("fallback_source") or req.datasource,
                            "fallback": bool(show_data.get("fallback_source")),
                        },
                    })
                else:
                    # Why did this series file fail? Distinguish "season failed
                    # to download" / "episode list failed" / "show found but no
                    # episode fit" / "source errored" / "key missing" /
                    # "genuinely no results".
                    if fs is not None and fs in failed_seasons:
                        reason = (
                            f"Season {fs} could not be loaded from "
                            f"{eff_source} ({failed_seasons[fs]})"
                        )
                    elif show_data and episodes_fetch_error:
                        reason = (
                            f"Episode list could not be loaded from "
                            f"{eff_source} ({episodes_fetch_error})"
                        )
                    elif show_data:
                        reason = f"No episode match in '{show_data.get('name', group_name)}'"
                    elif req.datasource in source_errors:
                        reason = f"{req.datasource} error: {source_errors[req.datasource]}"
                        if fallback_tried:
                            reason += (
                                f"; fallback {fallback_tried} also failed: {source_errors[fallback_tried]}"
                                if fallback_tried in source_errors
                                else f"; fallback {fallback_tried} found nothing"
                            )
                    elif req.datasource == "tmdb" and not tmdb.enabled:
                        reason = "TMDb key not configured — add it in Settings"
                        if fallback_tried:
                            reason += " (tvmaze fallback found nothing)"
                    else:
                        reason = f"No results for '{group_name}'"
                        if fallback_tried:
                            reason += f" (also tried {fallback_tried})"
                    results.append({
                        "original": f["path"],
                        "filename": f["filename"],
                        "new_path": None,
                        "new_name": None,
                        "preview": None,
                        "score": 0,
                        "matched": False,
                        "metadata": None,
                        "reason": reason,
                    })

        elif media_type == "movie":
            # ── Gather candidates from every configured source, then rank ──────
            # Rather than source-priority (TMDB unless empty), we merge TMDB and
            # OMDb results and let cascade_score pick the best across both. This
            # helps obscure / foreign / adult titles one source may miss. Each
            # source uses the trimmed-query fallback so a noisy name still hits.
            movie_candidates: list = []  # list of dicts with unified shape

            if tmdb.enabled:
                tmdb_results, errs = await _cascade_search(
                    lambda q, y: cached(("tmdb", "search_movie", q, y, req.include_adult),
                                        lambda: tmdb.search_movie(q, y, include_adult=req.include_adult)),
                    group_name, year,
                )
                if errs:
                    source_errors.setdefault("tmdb", errs[0])
                for r in tmdb_results:
                    movie_candidates.append({
                        "title": r.title,
                        "original_title": r.original_title,
                        "year": r.year,
                        "poster": r.poster_url_small,
                        "id": r.id,
                        "source": "tmdb",
                    })

            if omdb.enabled:
                omdb_results, errs = await _cascade_search(
                    lambda q, y: cached(("omdb", "search_movie", q, y),
                                        lambda: omdb.search_movie(q, y)), group_name, year,
                )
                if errs:
                    source_errors.setdefault("omdb", errs[0])
                for r in omdb_results:
                    movie_candidates.append({
                        "title": r.title,
                        "original_title": r.title,   # OMDb doesn't split original_title
                        "year": r.year,
                        "poster": r.poster_url,
                        "id": r.imdb_id,
                        "source": "omdb",
                    })

            # De-duplicate candidates that appear in both sources (same title+year);
            # keep the first (TMDB, which carries richer metadata + poster).
            deduped: list = []
            seen_keys: set = set()
            for c in movie_candidates:
                key = ((c.get("title") or "").strip().lower(), c.get("year"))
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                deduped.append(c)
            movie_candidates = deduped

            template = req.template or TEMPLATES["movie"]
            for f in group_files:
                best_movie: Optional[dict] = None
                best_score = 0.0

                for candidate in movie_candidates:
                    # Score against both display title and original title, take the higher
                    ns_title = name_similarity(f["clean_name"], candidate["title"])
                    ns_orig  = name_similarity(f["clean_name"], candidate.get("original_title") or "")
                    ns = max(ns_title, ns_orig)

                    # Year bonus/penalty (±1 year tolerance)
                    score = cascade_score(
                        file_name=f["clean_name"],
                        file_season=None,
                        file_episode=None,
                        file_absolute=None,
                        file_year=f.get("year"),
                        meta_name=candidate["title"],
                        meta_year=candidate.get("year"),
                    )

                    # If original_title gives a better name-similarity, boost by the delta
                    if ns_orig > ns_title:
                        score += (ns_orig - ns_title) * 0.5

                    score = min(score, 1.0)

                    if score > best_score:
                        best_score = score
                        best_movie = candidate

                if best_movie:
                    # Per-metric breakdown for the chosen candidate (item 7).
                    score_detail = cascade_breakdown(
                        file_name=f["clean_name"],
                        file_season=None,
                        file_episode=None,
                        file_absolute=None,
                        file_year=f.get("year"),
                        meta_name=best_movie["title"],
                        meta_year=best_movie.get("year"),
                    )["components"]
                    bindings = {
                        "n": best_movie["title"],
                        "y": best_movie.get("year") or "",
                        "t": best_movie["title"],
                        "source": f.get("source", ""),
                        "vf": f.get("video_format", ""),
                        "group": f.get("group", ""),
                        "codec": f.get("codec") or "",
                        "audio": f.get("audio") or "",
                        "edition": f.get("edition") or "",
                        "id": best_movie["id"],
                        "tmdbid": best_movie["id"] if best_movie["source"] == "tmdb" else "",
                        "imdbid": best_movie["id"] if best_movie["source"] == "omdb" else "",
                    }
                    original = Path(f["path"])
                    new_path = build_new_path(original, template, bindings, original.parent)
                    results.append({
                        "original": f["path"],
                        "filename": f["filename"],
                        "new_path": str(new_path),
                        "new_name": new_path.name,
                        "preview": new_path.name,
                        "score": round(min(best_score, 1.0), 3),
                        "score_detail": score_detail,
                        "matched": True,
                        "metadata": {
                            "title": best_movie["title"],
                            "year": best_movie.get("year"),
                            "poster": best_movie.get("poster"),
                        },
                    })
                else:
                    # Why did this movie fail? Merge errors from both sources.
                    src_errs = "; ".join(
                        f"{s} error: {e}" for s, e in source_errors.items()
                        if s in ("tmdb", "omdb")
                    )
                    if movie_candidates:
                        reason = f"No close match for '{group_name}'"
                    elif src_errs:
                        reason = src_errs
                    elif not tmdb.enabled and not omdb.enabled:
                        reason = "No metadata source configured — add an API key in Settings"
                    else:
                        reason = f"No results for '{group_name}'"
                    results.append({
                        "original": f["path"],
                        "filename": f["filename"],
                        "new_path": None,
                        "new_name": None,
                        "preview": None,
                        "score": 0,
                        "matched": False,
                        "metadata": None,
                        "reason": reason,
                    })
        else:
            for f in group_files:
                results.append({
                    "original": f["path"],
                    "filename": f["filename"],
                    "new_path": None,
                    "new_name": None,
                    "preview": None,
                    "score": 0,
                    "matched": False,
                    "metadata": None,
                    "reason": "Could not detect series/movie from filename",
                })

    # ── Subtitle companion pairing ─────────────────────────────────────────
    # Build a lookup from each matched video's original stem → its new_path stem.
    # A subtitle companion is identified by sharing the same stem (ignoring any
    # trailing language tag such as ".en" or ".forced.en").
    video_stem_map: dict[str, dict] = {}
    for r in results:
        if r.get("matched") and r.get("new_path"):
            orig_stem = Path(r["original"]).stem.lower()
            video_stem_map[orig_stem] = r

    for sf in subtitle_files:
        sub_path = Path(sf["path"])
        sub_ext = sub_path.suffix.lower()
        lang_tag = extract_subtitle_lang_tag(sub_path)
        # The "clean" stem is the subtitle stem with the lang tag stripped
        sub_stem_full = sub_path.stem  # e.g. "Show.S01E01.en"
        if lang_tag:
            # strip the lang tag suffix from the stem
            clean_stem = sub_stem_full[: len(sub_stem_full) - len(lang_tag)]
        else:
            clean_stem = sub_stem_full

        companion = video_stem_map.get(clean_stem.lower())

        if companion:
            # Derive new subtitle path from the companion video's new_path
            companion_new = Path(companion["new_path"])
            new_sub_name = companion_new.stem + lang_tag + sub_ext
            new_sub_path = companion_new.parent / new_sub_name
            results.append({
                "original": sf["path"],
                "filename": sf["filename"],
                "new_path": str(new_sub_path),
                "new_name": new_sub_name,
                "preview": new_sub_name,
                "score": companion["score"],
                "matched": True,
                "metadata": companion.get("metadata"),
                "is_subtitle": True,
            })
        else:
            # No companion video matched — skip (do not rename)
            results.append({
                "original": sf["path"],
                "filename": sf["filename"],
                "new_path": None,
                "new_name": None,
                "preview": None,
                "score": 0,
                "matched": False,
                "is_subtitle": True,
                "reason": "Subtitle skipped — companion video not in this batch",
            })

    # Detect conflicts
    conflicts = []
    dest_paths = {}
    
    for r in results:
        if not r["matched"] or not r["new_path"]:
            continue
            
        new_path = Path(r["new_path"])
        
        # Check for duplicate destinations
        if r["new_path"] in dest_paths:
            conflicts.append({
                "type": "duplicate_destination",
                "files": [dest_paths[r["new_path"]], r["original"]],
                "destination": r["new_path"],
                "message": f"Multiple files would rename to: {new_path.name}",
            })
        else:
            dest_paths[r["new_path"]] = r["original"]
        
        # Check if destination already exists (and it's not the same file)
        if new_path.exists() and str(new_path.resolve()) != str(Path(r["original"]).resolve()):
            conflicts.append({
                "type": "file_exists",
                "file": r["original"],
                "destination": r["new_path"],
                "message": f"Destination already exists: {new_path.name}",
            })

    return {"results": results, "conflicts": conflicts, "source_errors": source_errors}


# ─── Rename Endpoint ───────────────────────────────────────────────────

def _rename_sync(operations: list, action: RenameAction, batch_id: str) -> tuple:
    """Blocking rename loop — runs in a worker thread via asyncio.to_thread so
    a multi-GB copy or cross-device move never freezes the event loop (the
    same bug class as the v1.3.0 scan freeze; it also starved the Docker
    HEALTHCHECK into marking the container unhealthy). Updates the
    rename_progress snapshot before each operation so the UI can render
    'Renaming 3/12: file…' while the copy runs."""
    results = []
    history_entries = []

    for op in operations:
        source = Path(op["original"])
        dest = Path(op["new_path"])

        rename_progress["current"] += 1
        rename_progress["file"] = source.name

        if not source.exists():
            results.append({
                "original": str(source),
                "destination": str(dest),
                "success": False,
                "error": "Source file not found",
            })
            continue

        result = execute_rename(source, dest, action)
        results.append({
            "original": str(result.original),
            "destination": str(result.destination),
            "success": result.success,
            "error": result.error,
        })

        # Record in history
        history_entries.append(HistoryEntry(
            id=str(uuid.uuid4()),
            timestamp=datetime.now().isoformat(),
            action=action.value,
            original=str(result.original),
            destination=str(result.destination),
            success=result.success,
            error=result.error,
            batch_id=batch_id,
        ))

    return results, history_entries


@app.post("/api/rename")
async def rename_files(req: RenameRequest):
    """Execute rename operations in a worker thread with live progress."""
    action = RenameAction(req.action)
    # One Rename click = one history batch (drives "Undo all" in the UI).
    batch_id = str(uuid.uuid4())

    rename_progress.update(active=True, current=0, total=len(req.operations), file="")
    try:
        results, history_entries = await asyncio.to_thread(
            _rename_sync, req.operations, action, batch_id
        )
    finally:
        # Covers success AND an op raising mid-loop — the UI ticker must
        # never keep showing a dead run.
        rename_progress["active"] = False

    # History write stays on the event loop, after the thread finishes —
    # one writer, no thread crossing into the history file.
    if history_entries:
        history.add_batch(history_entries)

    return {
        "action": action.value,
        "batch_id": batch_id,
        "total": len(results),
        "success": sum(1 for r in results if r["success"]),
        "failed": sum(1 for r in results if not r["success"]),
        "results": results,
    }


# ─── Utility Endpoints ─────────────────────────────────────────────────

@app.get("/api/templates")
async def get_templates():
    return TEMPLATES


class PreviewRequest(BaseModel):
    """A naming template plus a sample file's detected fields, for live preview."""
    template: str
    sample: dict = {}

    @field_validator("template")
    @classmethod
    def validate_template(cls, v: str) -> str:
        if len(v) > 500:
            raise ValueError("Template too long.")
        return v


@app.post("/api/preview-template")
async def preview_template(req: PreviewRequest):
    """Format a template against a sample file using the SAME apply_template the
    real rename uses — so the preview can never drift from the actual output.
    Missing fields fall back to readable placeholders."""
    s = req.sample or {}

    def pick(key, default):
        val = s.get(key)
        return default if val in (None, "") else val

    # Music samples (media_type "music" from _file_entry) get music-flavored
    # placeholders. {title} resolves through "t" via the formatter's alias
    # loop, so ONE binding serves episode and track titles — a separate
    # "title" key would leak "Track Title" into TV previews for video samples
    # (their _file_entry carries title=None).
    is_music = s.get("media_type") == "music"
    bindings = {
        "n": pick("clean_name", "Show Name"),
        "y": pick("year", 2024),
        "s": s.get("season") if s.get("season") is not None else 1,
        "e": s.get("episode") if s.get("episode") is not None else 1,
        "e_end": s.get("episode_end"),
        "t": pick("title", "Track Title" if is_music else "Episode Title"),
        "absolute": s.get("absolute") if s.get("absolute") is not None else 1,
        "d": pick("date", "2024-01-01"),
        "source": pick("source", "WEB-DL"),
        "vf": pick("video_format", "1080p"),
        "group": pick("group", "GROUP"),
        "codec": pick("codec", "x265"),
        "audio": pick("audio", "AAC"),
        # Edition defaults EMPTY on purpose: most files have none, and the
        # formatter's cleanup collapses the surrounding "[]" — a placeholder
        # would make every preview claim an Extended cut.
        "edition": s.get("edition") or "",
        "id": pick("id", 0),
        # Ids exist only after matching (scan samples never carry them) —
        # empty here, so "[imdbid-{imdbid}]" previews collapse cleanly.
        "tmdbid": "",
        "imdbid": "",
        # Music tokens: real values from the parsed stem (parse_music_info),
        # placeholders otherwise. {track} zero-pads exactly like the real
        # music match path (zfill(2)) so preview and rename can't drift.
        "artist": pick("artist", "Artist"),
        "album": pick("album", "Album"),
        "track": str(s.get("track") or 1).zfill(2),
    }
    try:
        preview = apply_template(req.template, bindings)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid template: {exc}")
    return {"preview": preview}


# Display metadata for each rename action, served via /api/actions so the UI
# dropdown can never drift from the RenameAction enum again (KEEPLINK was fully
# implemented but unreachable for months because the list was hardcoded in
# index.html). Dict order = display order in the UI.
ACTION_META = {
    RenameAction.RENAME:   ("Rename (in-place)", "Rename in place — files stay in their current folders."),
    RenameAction.TEST:     ("Test (Dry Run)",    "Dry run — nothing changes on disk."),
    RenameAction.MOVE:     ("Move",              "Move relocates files into new folders — they leave this location."),
    RenameAction.KEEPLINK: ("Move + Keep Link",  "Moves the file and leaves a symlink at the old path — torrents keep seeding. Not for SMB/FAT."),
    RenameAction.COPY:     ("Copy",              "Copy keeps originals and creates renamed copies."),
    RenameAction.HARDLINK: ("Hard Link",         "Hard link — same file, second name. Same filesystem only."),
    RenameAction.SYMLINK:  ("Symlink",           "Symlink points back to the original. Not for SMB/FAT."),
}


@app.get("/api/actions")
async def get_actions():
    items = [
        {"value": a.value, "label": label, "hint": hint}
        for a, (label, hint) in ACTION_META.items()
    ]
    # Safety net: any enum member missing from ACTION_META still gets listed,
    # so a future action can never silently vanish from the UI again.
    listed = {i["value"] for i in items}
    items.extend(
        {"value": a.value, "label": a.value.title(), "hint": ""}
        for a in RenameAction if a.value not in listed
    )
    return items


# ─── Version / update check ────────────────────────────────────────────

# One check per 24 h, cached in memory (per process — a container restart
# re-checks, which is fine). Failures cache as "no update" so a GitHub outage
# or an offline LAN never delays a request beyond the 3 s timeout, and only
# once per day. CINESORT_UPDATE_CHECK=0 disables the outbound request entirely
# (deployment-layer knob, same pattern as CINESORT_BROWSE_ROOTS).
GITHUB_LATEST_URL = "https://api.github.com/repos/aiulian25/cinesort/releases/latest"
UPDATE_CHECK_INTERVAL = 86400.0
_update_cache: dict = {"checked_at": 0.0, "result": None}


def _version_tuple(v: str) -> tuple:
    """'v1.10.2' → (1, 10, 2); unparseable → () (compares as 'no update')."""
    try:
        return tuple(int(x) for x in v.strip().lstrip("v").split("."))
    except ValueError:
        return ()


async def _check_update() -> Optional[dict]:
    if os.environ.get("CINESORT_UPDATE_CHECK", "1") == "0":
        return None
    now = time.time()
    if now - _update_cache["checked_at"] < UPDATE_CHECK_INTERVAL:
        return _update_cache["result"]
    # Stamp BEFORE the request so failures also back off for 24 h.
    _update_cache["checked_at"] = now
    _update_cache["result"] = None
    try:
        async with httpx.AsyncClient(
            timeout=3.0, headers={"Accept": "application/vnd.github+json"}
        ) as client:
            resp = await client.get(GITHUB_LATEST_URL)
            resp.raise_for_status()
            data = resp.json()
        latest = (data.get("tag_name") or "").lstrip("v")
        latest_t = _version_tuple(latest)
        if latest_t and latest_t > _version_tuple(app.version):
            _update_cache["result"] = {
                "latest": latest,
                "url": data.get("html_url")
                       or "https://github.com/aiulian25/cinesort/releases",
                # Asset list so the desktop shell can auto-download the right
                # package (type+arch) instead of sending users to the release
                # page. size + sha256 digest let the downloader verify
                # integrity end-to-end.
                "assets": [
                    {
                        "name": a.get("name"),
                        "url": a.get("browser_download_url"),
                        "size": a.get("size"),
                        "digest": a.get("digest"),
                    }
                    for a in (data.get("assets") or [])
                    if a.get("name") and a.get("browser_download_url")
                ],
            }
    except Exception:
        pass   # best-effort: no update info beats a slow/failing Settings modal
    return _update_cache["result"]


@app.get("/api/version")
async def get_version():
    """Running version + available update (or null). Never raises; never
    returns anything sensitive — safe on every build target."""
    return {"version": app.version, "update": await _check_update()}


# ─── History Endpoints ─────────────────────────────────────────────────

@app.get("/api/history")
async def get_history(limit: int = 50):
    """Get recent rename operations."""
    entries = history.get_recent(limit)
    return {"history": [
        {
            "id": e.id,
            "timestamp": e.timestamp,
            "action": e.action,
            "original": e.original,
            "destination": e.destination,
            "success": e.success,
            "error": e.error,
            "batch_id": e.batch_id,
        }
        for e in entries
    ]}


@app.post("/api/undo/{operation_id}")
async def undo_operation(operation_id: str):
    """Undo a specific rename operation."""
    success, message = history.undo(operation_id)
    if not success:
        raise HTTPException(status_code=400, detail=message)
    return {"success": True, "message": message}


@app.post("/api/undo-batch/{batch_id}")
async def undo_batch(batch_id: str):
    """Undo every undoable entry of a rename batch (reverse order)."""
    results = history.undo_batch(batch_id)
    if not results:
        raise HTTPException(status_code=404, detail="Batch not found or nothing to undo")
    return {
        "total": len(results),
        "success": sum(1 for r in results if r["success"]),
        "results": results,
    }


@app.delete("/api/history")
async def clear_history():
    """Clear all history."""
    history.clear_history()
    return {"success": True, "message": "History cleared"}


# ─── Settings Endpoints ────────────────────────────────────────────────────────

@app.get("/api/settings")
async def get_settings():
    """
    Return which API keys are currently active.
    NEVER returns key values — only presence booleans and the config file path
    so the UI can show where to edit manually if needed.
    """
    status = read_config_status()
    return {
        "tmdb_key_set": status.get("TMDB_API_KEY", False),
        "omdb_key_set": status.get("OMDB_API_KEY", False),
        # Let the UI show where the file lives (helpful for power users)
        "config_file": str(config_file()),
        # Indicate whether each client is actually usable right now
        "tmdb_enabled": tmdb.enabled,
        "omdb_enabled": omdb.enabled,
        # Metadata language (not a secret — safe to echo back for the UI field)
        "tmdb_language": os.environ.get("TMDB_LANGUAGE", ""),
        # Confidence thresholds — the frontend adopts these at startup so all
        # build targets share one gate (see LOW_CONFIDENCE_THRESHOLD above).
        "low_confidence": LOW_CONFIDENCE_THRESHOLD,
        "review_confidence": REVIEW_CONFIDENCE_THRESHOLD,
    }


@app.post("/api/settings")
async def post_settings(req: SettingsRequest):
    """
    Save API keys to ~/.config/cinesort/keys.env (desktop installs) and
    hot-reload them into the running process — no restart required.

    Docker users whose keys come from docker-compose env vars are unaffected:
    save_config() will not overwrite existing os.environ entries, but it WILL
    update the file so desktop users who later run outside Docker also benefit.
    """
    global tmdb, omdb

    updates: dict[str, str] = {}
    if req.tmdb_key != "":
        updates["TMDB_API_KEY"] = req.tmdb_key
    elif req.tmdb_key == "" and "TMDB_API_KEY" in (req.model_fields_set or set()):
        updates["TMDB_API_KEY"] = ""   # explicit clear

    if req.omdb_key != "":
        updates["OMDB_API_KEY"] = req.omdb_key
    elif req.omdb_key == "" and "OMDB_API_KEY" in (req.model_fields_set or set()):
        updates["OMDB_API_KEY"] = ""

    # Language: unlike the keys (empty = keep, they're write-only password
    # fields), the language field is visible and prefilled — empty means
    # "clear back to TMDb's default English". save_config removes the entry
    # on "".
    if req.tmdb_language != "":
        updates["TMDB_LANGUAGE"] = req.tmdb_language
    elif "tmdb_language" in (req.model_fields_set or set()):
        updates["TMDB_LANGUAGE"] = ""

    if updates:
        save_config(updates)   # writes file + updates os.environ in-place

    # Re-instantiate API clients so the new keys take effect immediately
    # without needing an app restart.
    old_tmdb = tmdb
    old_omdb = omdb
    tmdb = TMDbClient()
    omdb = OMDbClient()
    await old_tmdb.close()
    await old_omdb.close()

    # Cached responses may have been fetched with the old key/metadata
    # language — drop them so a settings change takes effect immediately
    # instead of after the TTL.
    provider_cache.clear()

    status = read_config_status()
    return {
        "success": True,
        "tmdb_key_set": status.get("TMDB_API_KEY", False),
        "omdb_key_set": status.get("OMDB_API_KEY", False),
        "tmdb_enabled": tmdb.enabled,
        "omdb_enabled": omdb.enabled,
    }


@app.on_event("shutdown")
async def shutdown():
    await tmdb.close()
    await tvmaze.close()
    await omdb.close()
