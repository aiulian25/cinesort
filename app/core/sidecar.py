"""Kodi / Jellyfin / Plex sidecar files — .nfo metadata and poster art.

Written AFTER a successful rename, so the ids CineSort matched travel with the
file instead of leaving the media server to re-scrape from the filename (where
a "Sleep (2023)" can silently become a different title entirely).

Two naming dialects exist for these files. The folder-level one (movie.nfo,
poster.jpg) is only correct when the template gave the title its own folder;
under the Flat preset it would label a whole shared library as one title. The
file-level one (<stem>.nfo, <stem>-poster.jpg) is correct in BOTH layouts, so
that is the default here and folder-level files are written only when a real
per-title folder was detected.

Nothing in this module is allowed to fail a rename: callers treat every error
as a reportable warning.
"""

import asyncio
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx

from app.core.matcher import normalize


# Poster hosts we will fetch from. The URL reaches us inside the rename
# request body — i.e. from the browser — so this is an SSRF boundary, not a
# convenience filter. Compared with EQUALITY against the parsed hostname:
# a suffix test would accept "image.tmdb.org.attacker.example".
ALLOWED_POSTER_HOSTS = frozenset({
    "image.tmdb.org",        # TMDb
    "m.media-amazon.com",    # OMDb (see app/api/omdb.py)
    "static.tvmaze.com",     # TVmaze
})

# A poster is a JPEG of a few hundred KB. The cap is enforced while streaming
# so an allow-listed host that turned hostile cannot fill the media volume.
MAX_POSTER_BYTES = 8 * 1024 * 1024

POSTER_TIMEOUT_SECONDS = 15.0

# TMDb serves the same image at any width; stored URLs are the w154 thumbnails
# the dialogs use. Media servers want something bigger.
_TMDB_SIZE_RE = re.compile(r"/t/p/w\d+/")
POSTER_WIDTH = "w342"

TMP_SUFFIX = ".cinesort-tmp"


# ── XML writing ───────────────────────────────────────────────────────────

def _sub(parent: ET.Element, tag: str, value) -> None:
    """Append <tag>value</tag>, skipping empty values so a sparse match never
    writes <year></year> — Kodi treats an empty element as an assertion that
    the field is blank, which overrides its own scraper."""
    if value is None or value == "":
        return
    ET.SubElement(parent, tag).text = str(value)


def _unique_ids(parent: ET.Element, meta: dict) -> None:
    """<uniqueid> elements. The first one written is marked default — that is
    the id the media server treats as authoritative."""
    first = True
    for kind, key in (("tmdb", "tmdbid"), ("imdb", "imdbid")):
        value = str(meta.get(key) or "").strip()
        if not value:
            continue
        attrs = {"type": kind}
        if first:
            attrs["default"] = "true"
            first = False
        ET.SubElement(parent, "uniqueid", attrs).text = value


def _write_xml(path: Path, root: ET.Element, force: bool) -> Optional[Path]:
    """Atomic write; returns the path written, or None when one already exists.

    Existing sidecars are left alone: they may have been hand-corrected, and
    silently overwriting a user's curation is the one failure mode this
    feature must not have.
    """
    if path.exists() and not force:
        return None
    ET.indent(root, space="  ")
    body = ET.tostring(root, encoding="unicode")
    tmp = path.with_name(path.name + TMP_SUFFIX)
    tmp.write_text(f"<?xml version='1.0' encoding='utf-8'?>\n{body}\n", encoding="utf-8")
    tmp.replace(path)
    return path


def write_movie_nfo(video_path: Path, meta: dict, force: bool = False) -> Optional[Path]:
    """<stem>.nfo beside the renamed film."""
    root = ET.Element("movie")
    _sub(root, "title", meta.get("title"))
    _sub(root, "originaltitle", meta.get("original_title") or meta.get("title"))
    _sub(root, "year", meta.get("year"))
    _sub(root, "plot", meta.get("overview"))
    _unique_ids(root, meta)
    # F9 has not landed yet; when it does, "collection" appears here and the
    # <set> block starts emitting with no further change.
    collection = meta.get("collection")
    if collection:
        _sub(ET.SubElement(root, "set"), "name", collection)
    return _write_xml(video_path.with_suffix(".nfo"), root, force)


def write_episode_nfo(video_path: Path, meta: dict, force: bool = False) -> Optional[Path]:
    """<stem>.nfo beside the renamed episode.

    Deliberately carries NO <uniqueid>: we hold the SHOW's TMDb id, not the
    episode's, and writing the show id here would assert a wrong episode
    identity. Kodi and Jellyfin resolve episodes by season/episode number
    under the show identified in tvshow.nfo.
    """
    root = ET.Element("episodedetails")
    _sub(root, "title", meta.get("title"))
    _sub(root, "showtitle", meta.get("show"))
    _sub(root, "season", meta.get("season"))
    _sub(root, "episode", meta.get("episode"))
    _sub(root, "aired", meta.get("air_date"))
    _sub(root, "plot", meta.get("overview"))
    return _write_xml(video_path.with_suffix(".nfo"), root, force)


def write_tvshow_nfo(show_dir: Path, meta: dict, force: bool = False) -> Optional[Path]:
    """tvshow.nfo at the root of the show's own folder. Folder-level by
    definition — the caller only supplies a directory it actually resolved."""
    root = ET.Element("tvshow")
    _sub(root, "title", meta.get("show"))
    _sub(root, "year", meta.get("show_year"))
    _unique_ids(root, meta)
    return _write_xml(show_dir / "tvshow.nfo", root, force)


# ── Poster art ────────────────────────────────────────────────────────────

def poster_url(meta: dict) -> Optional[str]:
    """The stored URL, upsized for TMDb (we keep w154 thumbnails for dialogs)."""
    url = (meta.get("poster") or "").strip()
    if not url:
        return None
    return _TMDB_SIZE_RE.sub(f"/t/p/{POSTER_WIDTH}/", url)


def _check_poster_url(url: str) -> str:
    """Raise ValueError unless this is an https URL on an allow-listed host."""
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError(f"Poster URL must be https: {url}")
    if parsed.hostname not in ALLOWED_POSTER_HOSTS:
        raise ValueError(f"Poster host not allowed: {parsed.hostname}")
    return url


async def download_poster(url: str, dest: Path, client: httpx.AsyncClient,
                          force: bool = False) -> Optional[Path]:
    """Fetch one poster to `dest`. Returns the path written, or None when it
    already exists.

    Redirects are NOT followed (httpx's default): a 30x from an allow-listed
    host is the one way the host check could be walked past, so it fails loudly
    instead. The size cap is applied while streaming, not after.
    """
    _check_poster_url(url)
    if dest.exists() and not force:
        return None

    tmp = dest.with_name(dest.name + TMP_SUFFIX)
    written = 0
    try:
        async with client.stream("GET", url, timeout=POSTER_TIMEOUT_SECONDS) as resp:
            resp.raise_for_status()
            with tmp.open("wb") as fh:
                async for chunk in resp.aiter_bytes():
                    written += len(chunk)
                    if written > MAX_POSTER_BYTES:
                        raise ValueError(
                            f"Poster exceeds {MAX_POSTER_BYTES // (1024 * 1024)} MB: {url}")
                    fh.write(chunk)
        tmp.replace(dest)
        return dest
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


# ── Where folder-level sidecars belong ────────────────────────────────────

# Trailing decorations the templates add to a title folder:
#   "Breaking Bad (2008)", "Breaking Bad (2008) [imdbid-tt0903747]"
# (the README advertises the second form as a Jellyfin/Plex agent hint).
# Applied repeatedly, so both decorations come off.
_FOLDER_DECORATION_RE = re.compile(r"\s*[\(\[][^\(\)\[\]]*[\)\]]\s*$")

# How far above the file a title folder may sit. 1 covers "{name}/file",
# 2 covers "{name}/Season 1/file". Walking further would let a match against
# the library root itself ("/media/TV") qualify.
MAX_TITLE_FOLDER_DEPTH = 2


def _undecorate(name: str) -> str:
    """Strip every trailing "(…)"/"[…]" group from a folder name."""
    previous = None
    while previous != name:
        previous = name
        name = _FOLDER_DECORATION_RE.sub("", name)
    return name


def title_folder_for(video_path: Path, title: str,
                     max_depth: int = MAX_TITLE_FOLDER_DEPTH) -> Optional[Path]:
    """The folder that belongs to THIS title, or None when the template made none.

    tvshow.nfo and poster.jpg are folder-level claims: whatever directory they
    land in is declared to BE that title. With the TV preset
    ({name}/Season {s}/…) that directory exists; with the Flat preset
    ({name} - {s00e00} - {title}) the file lands straight in a shared
    destination root that may hold twenty other shows, and there is nothing
    safe to claim.

    Recognition is a normalized EQUALITY test after stripping one trailing
    "(…)" / "[…]" decoration — not a prefix test, which would accept
    "Breaking Bad Collection" as Breaking Bad's own folder. When nothing
    convincing is found the answer is None: a missing poster costs the user
    one download, a wrong folder mislabels their library.
    """
    wanted = normalize(title or "")
    if not wanted:
        return None

    # normalize() is the matcher's own comparison fold — it turns ":" and the
    # other characters sanitize_filename drops into separators, so the title
    # "Law & Order: SVU" recognises the folder "Law & Order SVU" it produced.
    for folder in list(video_path.parents)[:max_depth]:
        if normalize(folder.name) == wanted:
            return folder
        if normalize(_undecorate(folder.name)) == wanted:
            return folder
    return None


# ── One file's worth of sidecars ──────────────────────────────────────────

def _poster_target(video_path: Path, folder: Optional[Path]) -> Path:
    """poster.jpg inside the title's own folder, else the file-level form.

    Both are read by Kodi, Jellyfin and Plex; only the second one is safe in a
    layout where the file shares its directory with other titles.
    """
    if folder is not None:
        return folder / "poster.jpg"
    return video_path.with_name(f"{video_path.stem}-poster.jpg")


def _folder_for(video_path: Path, meta: dict) -> Optional[Path]:
    if meta.get("show"):
        return title_folder_for(video_path, meta["show"], MAX_TITLE_FOLDER_DEPTH)
    return title_folder_for(video_path, meta.get("title") or "", 1)


def write_nfos_for(video_path: Path, meta: dict,
                   force: bool = False) -> tuple[list[Path], list[str]]:
    """Blocking half: the .nfo files for one renamed video.

    Separate from the poster fetch so callers can push it to a worker thread —
    a 500-file batch would otherwise do 500 small writes on the event loop.
    Returns (paths written, error strings) and never raises.
    """
    written: list[Path] = []
    errors: list[str] = []

    def _record(fn, *args):
        try:
            path = fn(*args, force)
            if path is not None:
                written.append(path)
        except Exception as exc:
            errors.append(f"{video_path.name}: {type(exc).__name__}: {exc}")

    if meta.get("show"):
        _record(write_episode_nfo, video_path, meta)
        folder = _folder_for(video_path, meta)
        if folder is not None:
            _record(write_tvshow_nfo, folder, meta)
    else:
        _record(write_movie_nfo, video_path, meta)

    return written, errors


async def write_sidecars_for(video_path: Path, meta: dict,
                             client: Optional[httpx.AsyncClient],
                             force: bool = False) -> tuple[list[Path], list[str]]:
    """Every sidecar that applies to one renamed file.

    Returns (paths written, error strings). Never raises: the caller has
    already moved the user's file, and a metadata failure must not be able to
    report that rename as failed.
    """
    written, errors = await asyncio.to_thread(write_nfos_for, video_path, meta, force)

    folder = _folder_for(video_path, meta)
    # An episode without a show folder gets no art: the only image we hold is
    # the SHOW poster, and copying it next to every episode would both label
    # each episode with the show's art and re-download it once per file.
    if meta.get("show") and folder is None:
        return written, errors

    url = poster_url(meta)
    if not url or client is None:
        return written, errors

    try:
        path = await download_poster(url, _poster_target(video_path, folder), client, force)
        if path is not None:
            written.append(path)
    except Exception as exc:
        errors.append(f"{video_path.name}: poster: {type(exc).__name__}: {exc}")

    return written, errors
