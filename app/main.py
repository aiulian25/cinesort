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
from app.core.matcher import cascade_score, cascade_breakdown, name_similarity
from app.core.formatter import apply_template, build_new_path, TEMPLATES, sanitize_filename
from app.core.renamer import execute_rename, RenameAction, RenameResult
from app.core.history import history, HistoryEntry
from app.core.config import load_config, save_config, read_config_status, config_file
from app.api.tmdb import TMDbClient
from app.api.tvmaze import TVMazeClient
from app.api.omdb import OMDbClient
from app.api.musicbrainz import MusicBrainzClient
from datetime import datetime
import uuid

# ── Load user config (deb/AppImage: ~/.config/cinesort/keys.env) ─────────────
# Must happen BEFORE API clients are instantiated so os.environ is populated.
# Docker users: their env vars are already set; load_config() won't overwrite them.
load_config()


app = FastAPI(title="CineSort", version="1.3.1")


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
        # Music-only fields (None for video/subtitles)
        "artist": det.artist,
        "album": det.album,
        "track": det.track,
        "title": det.title,
    }


def _scan_dir_sync(path: str, recursive: bool) -> dict:
    base = Path(path)
    media_exts = VIDEO_EXTENSIONS | SUBTITLE_EXTENSIONS | AUDIO_EXTENSIONS

    if base.is_file():
        paths = [base]
    elif recursive:
        paths = sorted(base.rglob("*"))
    else:
        paths = sorted(base.iterdir())

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
            targets = sorted(p.rglob("*")) if recursive else sorted(p.iterdir())
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

# Matches at or below this confidence are flagged "needs review" and are NOT
# auto-selected for renaming by the front-end, so a weak guess can never rename
# a file unless the user opts in. Kept here (backend) so every build target —
# Docker, deb, AppImage — shares one threshold.
LOW_CONFIDENCE_THRESHOLD = 0.4


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
            results = await search_coro(q, y)
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

    # Real progress (replaces the old [DEBUG] prints): the UI polls
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
                recs = await mb.search_recording(
                    f.get("artist"), f.get("title") or f.get("clean_name") or ""
                )
            except Exception as exc:
                source_errors.setdefault("musicbrainz", _sanitize_error(exc))
                recs = []

            best, best_score = None, 0.0
            for c in recs:
                s = name_similarity(f.get("clean_name") or "", f"{c.artist} - {c.title}")
                if s > best_score:
                    best, best_score = c, s

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

        if media_type == "series":
            # Check if user already selected a specific show
            if req.selected_show_id and req.selected_show_name:
                # Use the pre-selected show
                if req.datasource == "tvmaze":
                    show_details = await tvmaze.get_show(req.selected_show_id)
                    show_data = {"id": show_details.id, "name": show_details.name, "year": show_details.year, "poster": show_details.image_url}
                    eps = await tvmaze.get_episodes(req.selected_show_id)
                    episodes_data = [
                        {"season": e.season, "episode": e.episode, "title": e.title, "air_date": e.air_date}
                        for e in eps
                    ]
                else:
                    show_details = await tmdb.get_tv_details(req.selected_show_id)
                    show_data = {"id": req.selected_show_id, "name": show_details.get("name"), "year": show_details.get("first_air_date", "")[:4] if show_details.get("first_air_date") else None, "poster": f"https://image.tmdb.org/t/p/w154{show_details.get('poster_path')}" if show_details.get("poster_path") else None}
                    seasons = show_details.get("seasons", [])
                    for s in seasons:
                        sn = s.get("season_number", 0)
                        try:
                            eps = await tmdb.get_tv_season(req.selected_show_id, sn)
                            episodes_data.extend([
                                {"season": e.season, "episode": e.episode, "title": e.title, "air_date": e.air_date}
                                for e in eps
                            ])
                        except Exception:
                            continue
            else:
                # Search (with progressively-trimmed fallback queries) and check
                # for multiple matches.
                if req.datasource == "tvmaze":
                    # TVmaze search has no year filter, so we only vary the query.
                    shows, errs = await _cascade_search(
                        lambda q, _y: tvmaze.search_shows(q), group_name, None
                    )
                    if errs:
                        source_errors.setdefault("tvmaze", errs[0])
                    shows = _disambiguate_by_year(shows, year)
                    if len(shows) > 1:
                        # Multiple matches - ask user to select
                        return {
                            "needs_selection": True,
                            "group_name": group_name,
                            "candidates": [
                                {"id": s.id, "name": s.name, "year": s.year, "poster": s.image_url, "overview": s.summary[:200] if s.summary else ""}
                                for s in shows[:10]
                            ],
                        }
                    elif shows:
                        show = shows[0]
                        show_data = {"id": show.id, "name": show.name, "year": show.year, "poster": show.image_url}
                        eps = await tvmaze.get_episodes(show.id)
                        episodes_data = [
                            {"season": e.season, "episode": e.episode, "title": e.title, "air_date": e.air_date}
                            for e in eps
                        ]
                else:
                    shows, errs = await _cascade_search(
                        lambda q, y: tmdb.search_tv(q, y), group_name, year
                    )
                    if errs:
                        source_errors.setdefault("tmdb", errs[0])
                    shows = _disambiguate_by_year(shows, year)
                    if len(shows) > 1:
                        # Multiple matches - ask user to select
                        return {
                            "needs_selection": True,
                            "group_name": group_name,
                            "candidates": [
                                {"id": s.id, "name": s.title, "year": s.year, "poster": s.poster_url_small, "overview": s.overview[:200] if s.overview else "", "rating": s.vote_average}
                                for s in shows[:10]
                            ],
                        }
                    elif shows:
                        show = shows[0]
                        show_data = {"id": show.id, "name": show.title, "year": show.year, "poster": show.poster_url_small}
                        # Fetch all seasons
                        details = await tmdb.get_tv_details(show.id)
                        seasons = details.get("seasons", [])
                        for s in seasons:
                            sn = s.get("season_number", 0)
                            try:
                                eps = await tmdb.get_tv_season(show.id, sn)
                                episodes_data.extend([
                                    {"season": e.season, "episode": e.episode, "title": e.title, "air_date": e.air_date}
                                    for e in eps
                                ])
                            except Exception:
                                continue

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

                if fs is not None and fe is not None and (fs, fe) in se_index:
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
                        "id": show_data["id"],
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
                        },
                    })
                else:
                    # Why did this series file fail? Distinguish "show found
                    # but no episode fit" / "source errored" / "key missing" /
                    # "genuinely no results".
                    if show_data:
                        reason = f"No episode match in '{show_data.get('name', group_name)}'"
                    elif req.datasource in source_errors:
                        reason = f"{req.datasource} error: {source_errors[req.datasource]}"
                    elif req.datasource == "tmdb" and not tmdb.enabled:
                        reason = "TMDb key not configured — add it in Settings"
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

        elif media_type == "movie":
            # ── Gather candidates from every configured source, then rank ──────
            # Rather than source-priority (TMDB unless empty), we merge TMDB and
            # OMDb results and let cascade_score pick the best across both. This
            # helps obscure / foreign / adult titles one source may miss. Each
            # source uses the trimmed-query fallback so a noisy name still hits.
            movie_candidates: list = []  # list of dicts with unified shape

            if tmdb.enabled:
                tmdb_results, errs = await _cascade_search(
                    lambda q, y: tmdb.search_movie(q, y, include_adult=req.include_adult),
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
                    lambda q, y: omdb.search_movie(q, y), group_name, year,
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
                print(f"[DEBUG] OMDb returned {len(omdb_results)} result(s) for '{group_name}'")

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

            print(f"[DEBUG] Total movie candidates for '{group_name}': {len(movie_candidates)}")

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
                        "id": best_movie["id"],
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

@app.post("/api/rename")
async def rename_files(req: RenameRequest):
    """Execute rename operations."""
    action = RenameAction(req.action)
    results = []
    history_entries = []
    # One Rename click = one history batch (drives "Undo all" in the UI).
    batch_id = str(uuid.uuid4())

    for op in req.operations:
        source = Path(op["original"])
        dest = Path(op["new_path"])

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
    
    # Save to history
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

    bindings = {
        "n": pick("clean_name", "Show Name"),
        "y": pick("year", 2024),
        "s": s.get("season") if s.get("season") is not None else 1,
        "e": s.get("episode") if s.get("episode") is not None else 1,
        "e_end": s.get("episode_end"),
        "t": pick("title", "Episode Title"),
        "absolute": s.get("absolute") if s.get("absolute") is not None else 1,
        "d": pick("date", "2024-01-01"),
        "source": pick("source", "WEB-DL"),
        "vf": pick("video_format", "1080p"),
        "group": pick("group", "GROUP"),
        "id": pick("id", 0),
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
