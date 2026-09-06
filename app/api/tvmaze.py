"""
TVmaze API client — completely free, no API key required.
https://www.tvmaze.com/api
"""

import re

import httpx
from dataclasses import dataclass
from typing import Optional


API_BASE = "https://api.tvmaze.com"

# Same shape TMDb validates against (tmdb.py). The id reaches us from the user
# and goes into a query parameter, so it is checked before the request is made
# rather than trusted to be well-formed.
_IMDB_ID_RE = re.compile(r"tt\d{7,8}")


@dataclass
class TVMazeShow:
    id: int
    name: str
    year: Optional[int] = None
    summary: str = ""
    image_url: Optional[str] = None
    status: str = ""
    genres: list[str] = None
    # TVmaze returns externals.imdb on every show; it was parsed away.
    imdb_id: Optional[str] = None

    def __post_init__(self):
        if self.genres is None:
            self.genres = []


@dataclass
class TVMazeEpisode:
    season: int
    episode: int
    title: str
    air_date: Optional[str] = None
    summary: str = ""


class TVMazeClient:
    def __init__(self):
        self._client = httpx.AsyncClient(
            base_url=API_BASE,
            timeout=15.0,
            headers={"Accept": "application/json"},
        )

    async def search_shows(self, query: str) -> list[TVMazeShow]:
        resp = await self._client.get("/search/shows", params={"q": query})
        resp.raise_for_status()
        data = resp.json()
        results = []
        for item in data:
            show = item.get("show", {})
            premiered = show.get("premiered", "") or ""
            image = show.get("image") or {}
            results.append(TVMazeShow(
                id=show["id"],
                name=show.get("name", ""),
                year=int(premiered[:4]) if len(premiered) >= 4 else None,
                summary=show.get("summary", "") or "",
                image_url=image.get("medium"),
                status=show.get("status", ""),
                genres=show.get("genres", []),
                imdb_id=(show.get("externals") or {}).get("imdb"),
            ))
        return results

    async def get_episodes(self, show_id: int) -> list[TVMazeEpisode]:
        # specials=1: TVmaze omits specials by default, so SP/season-0 files
        # could never match this source. Specials arrive interleaved in air
        # order with number=null, type "significant_special"/
        # "insignificant_special", and season set to the SURROUNDING season —
        # remap them to season 0 with sequential numbering (SP01 = first
        # special by air date), the same season-0 convention the detector
        # emits and TMDb already serves. Without the remap a null number
        # would collapse to (real_season, 0) junk keys.
        resp = await self._client.get(
            f"/shows/{show_id}/episodes", params={"specials": "1"}
        )
        resp.raise_for_status()
        data = resp.json()
        episodes = []
        special_no = 0
        for ep in data:
            if ep.get("number") is None or (ep.get("type") or "").endswith("special"):
                special_no += 1
                episodes.append(TVMazeEpisode(
                    season=0,
                    episode=special_no,
                    title=ep.get("name", ""),
                    air_date=ep.get("airdate"),
                    summary=ep.get("summary", "") or "",
                ))
                continue
            episodes.append(TVMazeEpisode(
                season=ep.get("season", 0),
                episode=ep.get("number", 0) or 0,
                title=ep.get("name", ""),
                air_date=ep.get("airdate"),
                summary=ep.get("summary", "") or "",
            ))
        return episodes

    def _to_show(self, show: dict) -> TVMazeShow:
        premiered = show.get("premiered", "") or ""
        image = show.get("image") or {}
        return TVMazeShow(
            id=show["id"],
            name=show.get("name", ""),
            year=int(premiered[:4]) if len(premiered) >= 4 else None,
            summary=show.get("summary", "") or "",
            image_url=image.get("medium"),
            status=show.get("status", ""),
            genres=show.get("genres", []),
            imdb_id=(show.get("externals") or {}).get("imdb"),
        )

    async def get_show(self, show_id: int) -> TVMazeShow:
        resp = await self._client.get(f"/shows/{show_id}")
        resp.raise_for_status()
        return self._to_show(resp.json())

    async def lookup_by_imdb(self, imdb_id: str) -> Optional[TVMazeShow]:
        """The show carrying this IMDb id, or None when TVmaze does not know it.

        Keyless, so this is the one IMDb→show bridge available to a deployment
        with no API keys at all. A 404 is the documented "unknown id" answer,
        not an error worth surfacing.
        """
        if not _IMDB_ID_RE.fullmatch(imdb_id or ""):
            raise ValueError(f"Invalid IMDb ID format: {imdb_id!r}")
        try:
            # This endpoint answers 301 → /shows/{id}; httpx does not follow
            # redirects by default. Following is enabled for THIS request only,
            # and the host of wherever it landed is checked afterwards — a
            # redirect is the one way a response could steer a request off the
            # API we meant to call.
            resp = await self._client.get(
                "/lookup/shows", params={"imdb": imdb_id}, follow_redirects=True)
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return None
            raise
        if resp.url.host != httpx.URL(API_BASE).host:
            raise RuntimeError(f"TVmaze lookup redirected off-site: {resp.url.host}")
        return self._to_show(resp.json())

    async def close(self):
        await self._client.aclose()
