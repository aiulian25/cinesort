"""
Media Renamer — FastAPI backend.
Serves the web UI and provides API endpoints for scanning, matching, and renaming.
"""

import os
import asyncio
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

from app.core.detector import (
    detect, MediaType, is_video_file, is_subtitle_file,
    VIDEO_EXTENSIONS, SUBTITLE_EXTENSIONS, extract_subtitle_lang_tag,
)
from app.core.matcher import cascade_score, name_similarity
from app.core.formatter import apply_template, build_new_path, TEMPLATES, sanitize_filename
from app.core.renamer import execute_rename, RenameAction, RenameResult
from app.core.history import history, HistoryEntry
from app.api.tmdb import TMDbClient
from app.api.tvmaze import TVMazeClient
from datetime import datetime
import uuid


app = FastAPI(title="CineSort", version="1.2.0")

# Serve static files
STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# API clients (shared instances)
# TMDbClient will read TMDB_API_KEY from environment if set, otherwise uses default
tmdb = TMDbClient()
tvmaze = TVMazeClient()


@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


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
    datasource: str = "tmdb"  # "tmdb" or "tvmaze"
    template: Optional[str] = None
    selected_show_id: Optional[int] = None  # User-selected show ID (bypasses search)
    selected_show_name: Optional[str] = None  # User-selected show name


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


# ─── Scan Endpoint ─────────────────────────────────────────────────────

@app.post("/api/scan")
async def scan_directory(req: ScanRequest):
    """Scan a directory for media files and auto-detect metadata."""
    base = Path(req.path)
    media_exts = VIDEO_EXTENSIONS | SUBTITLE_EXTENSIONS

    files = []
    if base.is_file():
        paths = [base]
    elif req.recursive:
        paths = sorted(base.rglob("*"))
    else:
        paths = sorted(base.iterdir())

    for p in paths:
        if not p.is_file():
            continue
        if p.suffix.lower() not in media_exts:
            continue

        det = detect(p)
        files.append({
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
        })

    return {"count": len(files), "files": files}


@app.post("/api/scan-batch")
async def scan_batch(req: BatchScanRequest):
    """Scan a list of individual file paths for media files."""
    media_exts = VIDEO_EXTENSIONS | SUBTITLE_EXTENSIONS
    files = []

    for path_str in req.paths:
        p = Path(path_str)
        if p.is_dir():
            targets = sorted(p.rglob("*"))
        else:
            targets = [p]

        for t in targets:
            if not t.is_file():
                continue
            if t.suffix.lower() not in media_exts:
                continue
            det = detect(t)
            files.append({
                "path": str(t),
                "filename": t.name,
                "size": t.stat().st_size,
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
            })

    return {"count": len(files), "files": files}


# ─── Browse Endpoint ───────────────────────────────────────────────────

@app.get("/api/browse")
async def browse_directory(path: str = Query("/mnt")):
    """Browse directories on the server. Returns list of subdirectories and files."""
    try:
        p = Path(path).resolve()
        
        # Security: only allow browsing within /mnt and /media
        allowed_roots = [Path("/mnt"), Path("/media")]
        if not any(p == root or root in p.parents for root in allowed_roots):
            # If path not under allowed roots, default to /mnt
            p = Path("/mnt")
        
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"Path does not exist: {path}")
        
        if not p.is_dir():
            raise HTTPException(status_code=400, detail=f"Path is not a directory: {path}")
        
        items = []
        
        # Add parent directory link (if not at root)
        if str(p) not in ["/mnt", "/media", "/"]:
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
    datasource: str = Query("tmdb", pattern="^(tmdb|tvmaze)$"),
    year: Optional[int] = None,
):
    """Search for TV shows or movies by name."""
    results = []

    if datasource == "tmdb":
        if type == "tv":
            raw = await tmdb.search_tv(q, year)
        else:
            raw = await tmdb.search_movie(q, year)
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

    return {"results": results}


# ─── Match Endpoint ────────────────────────────────────────────────────

@app.post("/api/match")
async def match_files(req: MatchRequest):
    """Match scanned files against metadata from TMDb/TVmaze.
    Groups files by detected series/movie, looks up metadata, and proposes renames."""

    results = []

    # Split subtitle files out — they are not matched independently.
    # They will be paired with their companion video file at the end.
    subtitle_files: list[dict] = []
    video_files: list[dict] = []
    for f in req.files:
        if Path(f["path"]).suffix.lower() in SUBTITLE_EXTENSIONS:
            subtitle_files.append(f)
        else:
            video_files.append(f)

    # Group VIDEO files only by detected name
    groups: dict[str, list[dict]] = {}
    for f in video_files:
        key = f.get("clean_name", "unknown")
        groups.setdefault(key, []).append(f)

    print(f"[DEBUG] Grouped {len(video_files)} video files into {len(groups)} groups; {len(subtitle_files)} subtitle(s) held for companion pairing")
    for group_name, group_files in groups.items():
        print(f"[DEBUG] Processing group: '{group_name}' ({len(group_files)} files)")
        sample = group_files[0]
        media_type = sample.get("media_type", "unknown")
        year = sample.get("year")
        print(f"[DEBUG] Media type: {media_type}, Year: {year}, Datasource: {req.datasource}")

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
                # Search and check for multiple matches
                if req.datasource == "tvmaze":
                    shows = await tvmaze.search_shows(group_name)
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
                    shows = await tmdb.search_tv(group_name, year)
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

            # Match each file to an episode
            template = req.template or TEMPLATES["series"]
            for f in group_files:
                best_ep = None
                best_score = 0
                for ep in episodes_data:
                    score = cascade_score(
                        file_name=f["clean_name"],
                        file_season=f.get("season"),
                        file_episode=f.get("episode"),
                        file_absolute=f.get("absolute"),
                        file_year=f.get("year"),
                        meta_name=show_data["name"] if show_data else "",
                        meta_season=ep["season"],
                        meta_episode=ep["episode"],
                        meta_year=show_data.get("year") if show_data else None,
                    )
                    if score > best_score:
                        best_score = score
                        best_ep = ep

                if best_ep and show_data:
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
                    results.append({
                        "original": f["path"],
                        "filename": f["filename"],
                        "new_path": None,
                        "new_name": None,
                        "preview": None,
                        "score": 0,
                        "matched": False,
                        "metadata": None,
                    })

        elif media_type == "movie":
            if req.datasource == "tmdb":
                movies = await tmdb.search_movie(group_name, year)
            else:
                movies = []

            template = req.template or TEMPLATES["movie"]
            for f in group_files:
                best_movie = None
                best_score = 0
                for movie in movies:
                    score = name_similarity(f["clean_name"], movie.title)
                    if year and movie.year:
                        if abs(year - movie.year) <= 1:
                            score += 0.3
                        else:
                            score -= 0.2
                    if score > best_score:
                        best_score = score
                        best_movie = movie

                if best_movie:
                    bindings = {
                        "n": best_movie.title,
                        "y": best_movie.year or "",
                        "t": best_movie.title,
                        "source": f.get("source", ""),
                        "vf": f.get("video_format", ""),
                        "group": f.get("group", ""),
                        "id": best_movie.id,
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
                        "matched": True,
                        "metadata": {
                            "title": best_movie.title,
                            "year": best_movie.year,
                            "poster": best_movie.poster_url_small,
                        },
                    })
                else:
                    results.append({
                        "original": f["path"],
                        "filename": f["filename"],
                        "new_path": None,
                        "new_name": None,
                        "preview": None,
                        "score": 0,
                        "matched": False,
                        "metadata": None,
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

    return {"results": results, "conflicts": conflicts}


# ─── Rename Endpoint ───────────────────────────────────────────────────

@app.post("/api/rename")
async def rename_files(req: RenameRequest):
    """Execute rename operations."""
    action = RenameAction(req.action)
    results = []
    history_entries = []

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
        ))
    
    # Save to history
    if history_entries:
        history.add_batch(history_entries)

    return {
        "action": action.value,
        "total": len(results),
        "success": sum(1 for r in results if r["success"]),
        "failed": sum(1 for r in results if not r["success"]),
        "results": results,
    }


# ─── Utility Endpoints ─────────────────────────────────────────────────

@app.get("/api/templates")
async def get_templates():
    return TEMPLATES


@app.get("/api/actions")
async def get_actions():
    return [{"value": a.value, "label": a.value.title()} for a in RenameAction]


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


@app.delete("/api/history")
async def clear_history():
    """Clear all history."""
    history.clear_history()
    return {"success": True, "message": "History cleared"}


@app.on_event("shutdown")
async def shutdown():
    await tmdb.close()
    await tvmaze.close()
