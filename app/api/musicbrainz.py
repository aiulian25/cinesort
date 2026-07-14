"""
MusicBrainz API client — completely free, no API key required.
https://musicbrainz.org/doc/MusicBrainz_API

Two hard requirements from MusicBrainz's terms (violations get the client
IP blocked): a descriptive User-Agent, and at most ONE request per second.
The throttle below serializes requests through a lock and sleeps out the
remainder of the 1 s window, so large batches are slow BY DESIGN — the UI's
match-progress polling keeps that visible.
"""

import asyncio
import time
import httpx
from dataclasses import dataclass
from typing import Optional


API_BASE = "https://musicbrainz.org/ws/2"
USER_AGENT = "CineSort/1.3.8 (https://github.com/aiulian25/cinesort)"
MIN_REQUEST_INTERVAL = 1.0   # seconds — MusicBrainz hard rate limit


@dataclass
class MBRecording:
    artist: str
    title: str
    album: Optional[str] = None
    track_no: Optional[int] = None
    year: Optional[int] = None
    score: int = 0   # MusicBrainz's own 0-100 relevance score
    # True when `album` came from an official studio album (release-group
    # primary-type Album, no secondary types like Live/Compilation).
    album_is_studio: bool = False


def _lucene_escape(s: str) -> str:
    """Escape the quote/backslash characters that would break a quoted
    Lucene phrase — filenames feed straight into the query string."""
    return s.replace("\\", "\\\\").replace('"', '\\"')


def _pick_release(releases: list) -> Optional[dict]:
    """Choose which release supplies the album title (and track number).

    `releases[0]` blindly took whatever MusicBrainz listed first — live
    verification once filed Nirvana under a live bootleg. The search response
    embeds each release's release-group with `primary-type` and
    `secondary-types` (Live/Compilation/Bootleg/… all appear as secondary
    types), so rank lexicographically: primary-type Album first, then no
    secondary types (a studio album), then having a release date. Ties keep
    the original list order (`max` returns the first maximum), so a recording
    whose only releases are live sets still matches exactly as before.
    """
    if not releases:
        return None

    def rank(r: dict):
        rg = r.get("release-group") or {}
        primary = (rg.get("primary-type") or "").lower()
        secondary = rg.get("secondary-types") or []
        return (primary == "album", not secondary, bool(r.get("date")))

    return max(releases, key=rank)


class MusicBrainzClient:
    def __init__(self):
        self._client = httpx.AsyncClient(
            base_url=API_BASE,
            timeout=15.0,
            params={"fmt": "json"},
            headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        )
        self._lock = asyncio.Lock()
        self._last_request = 0.0

    async def _throttled_get(self, url: str, params: dict) -> httpx.Response:
        """GET with the mandatory ≥1 s spacing between requests."""
        async with self._lock:
            wait = MIN_REQUEST_INTERVAL - (time.monotonic() - self._last_request)
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                return await self._client.get(url, params=params)
            finally:
                self._last_request = time.monotonic()

    async def search_recording(
        self,
        artist: Optional[str],
        title: str,
        limit: int = 10,
    ) -> list[MBRecording]:
        """Search recordings by (artist,) title. Returns [] when title empty."""
        title = (title or "").strip()
        if not title:
            return []
        if artist:
            query = f'artist:"{_lucene_escape(artist)}" AND recording:"{_lucene_escape(title)}"'
        else:
            query = f'recording:"{_lucene_escape(title)}"'

        # First pass restricts to recordings with an OFFICIAL STUDIO ALBUM
        # release. Without it, popular tracks drown in live-bootleg
        # recordings — "Lithium" returns 25+ concert recordings before the
        # Nevermind one (all scoring 100 on an exact-title query, in unstable
        # order), so no client-side ranking can recover the studio album.
        # Zero results (tracks existing only on singles/lives/compilations)
        # → one unfiltered retry, so nothing that matched before is lost.
        filtered = f"{query} AND primarytype:album AND -secondarytype:* AND status:official"
        resp = await self._throttled_get("/recording", {"query": filtered, "limit": str(limit)})
        resp.raise_for_status()
        data = resp.json()
        if not data.get("recordings"):
            resp = await self._throttled_get("/recording", {"query": query, "limit": str(limit)})
            resp.raise_for_status()
            data = resp.json()

        results: list[MBRecording] = []
        for rec in data.get("recordings", []):
            credits = rec.get("artist-credit") or []
            artist_name = (credits[0].get("name", "") if credits else "") or ""

            album = None
            track_no = None
            album_is_studio = False
            release = _pick_release(rec.get("releases") or [])
            if release:
                album = release.get("title")
                rg = release.get("release-group") or {}
                album_is_studio = ((rg.get("primary-type") or "").lower() == "album"
                                   and not (rg.get("secondary-types") or []))
                media = release.get("media") or []
                if media:
                    # Prefer the explicit track number; fall back to offset+1.
                    tracks = media[0].get("track") or []
                    if tracks and tracks[0].get("number"):
                        try:
                            track_no = int(tracks[0]["number"])
                        except (ValueError, TypeError):
                            track_no = None
                    if track_no is None:
                        offset = media[0].get("track-offset")
                        if isinstance(offset, int):
                            track_no = offset + 1

            frd = rec.get("first-release-date", "") or ""
            year = int(frd[:4]) if len(frd) >= 4 and frd[:4].isdigit() else None

            results.append(MBRecording(
                artist=artist_name,
                title=rec.get("title", ""),
                album=album,
                track_no=track_no,
                year=year,
                score=rec.get("score", 0) or 0,
                album_is_studio=album_is_studio,
            ))

        # Deterministic order for the caller's best-pick loop: relevance
        # first, then studio albums before live/compilation-only recordings,
        # then EARLIEST first-release year — the canonical original album
        # beats deluxe reissues and anniversary boxes. Exact-title queries
        # tie whole pages at score 100, and MusicBrainz returns those ties
        # in unstable order between calls.
        results.sort(key=lambda r: (-r.score, not r.album_is_studio,
                                    r.year if r.year is not None else 9999))
        return results

    async def close(self):
        await self._client.aclose()
