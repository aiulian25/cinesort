"""
TMDb API client — The Movie Database (movies + TV series).
Free API with generous limits. https://www.themoviedb.org/documentation/api
"""

import os
import httpx
from dataclasses import dataclass, field
from typing import Optional


API_BASE = "https://api.themoviedb.org/3"
IMAGE_BASE = "https://image.tmdb.org/t/p"



@dataclass
class TMDbResult:
    id: int
    title: str
    year: Optional[int] = None
    overview: str = ""
    poster_path: Optional[str] = None
    media_type: str = ""  # "movie" or "tv"
    vote_average: float = 0.0
    original_title: str = ""
    genres: list[str] = field(default_factory=list)

    @property
    def poster_url(self) -> Optional[str]:
        if self.poster_path:
            return f"{IMAGE_BASE}/w342{self.poster_path}"
        return None

    @property
    def poster_url_small(self) -> Optional[str]:
        if self.poster_path:
            return f"{IMAGE_BASE}/w154{self.poster_path}"
        return None


@dataclass
class TMDbEpisode:
    season: int
    episode: int
    title: str
    air_date: Optional[str] = None
    overview: str = ""
    still_path: Optional[str] = None


class TMDbClient:
    def __init__(self, api_key: Optional[str] = None):
        # Priority: 1) Provided key, 2) Environment variable, 3) None (disabled)
        self.api_key = api_key or os.getenv("TMDB_API_KEY", "")
        self.enabled = bool(self.api_key)
        
        self._client = httpx.AsyncClient(
            base_url=API_BASE,
            params={"api_key": self.api_key} if self.api_key else {},
            timeout=15.0,
            headers={"Accept": "application/json"},
        )

    async def search_movie(
        self,
        query: str,
        year: Optional[int] = None,
        include_adult: bool = False,
    ) -> list[TMDbResult]:
        if not self.enabled:
            return []
        params = {"query": query, "include_adult": "true" if include_adult else "false"}
        if year:
            params["year"] = str(year)
        resp = await self._client.get("/search/movie", params=params)
        resp.raise_for_status()
        data = resp.json()
        results = []
        for item in data.get("results", []):
            release = item.get("release_date", "") or ""
            results.append(TMDbResult(
                id=item["id"],
                title=item.get("title", ""),
                year=int(release[:4]) if len(release) >= 4 else None,
                overview=item.get("overview", ""),
                poster_path=item.get("poster_path"),
                media_type="movie",
                vote_average=item.get("vote_average", 0),
                original_title=item.get("original_title", ""),
            ))
        return results

    async def search_tv(self, query: str, year: Optional[int] = None) -> list[TMDbResult]:
        if not self.enabled:
            return []
        params = {"query": query}
        if year:
            params["first_air_date_year"] = str(year)
        resp = await self._client.get("/search/tv", params=params)
        resp.raise_for_status()
        data = resp.json()
        results = []
        for item in data.get("results", []):
            first_air = item.get("first_air_date", "") or ""
            results.append(TMDbResult(
                id=item["id"],
                title=item.get("name", ""),
                year=int(first_air[:4]) if len(first_air) >= 4 else None,
                overview=item.get("overview", ""),
                poster_path=item.get("poster_path"),
                media_type="tv",
                vote_average=item.get("vote_average", 0),
                original_title=item.get("original_name", ""),
            ))
        return results

    async def get_tv_season(self, tv_id: int, season: int) -> list[TMDbEpisode]:
        resp = await self._client.get(f"/tv/{tv_id}/season/{season}")
        resp.raise_for_status()
        data = resp.json()
        episodes = []
        for ep in data.get("episodes", []):
            episodes.append(TMDbEpisode(
                season=ep.get("season_number", season),
                episode=ep.get("episode_number", 0),
                title=ep.get("name", ""),
                air_date=ep.get("air_date"),
                overview=ep.get("overview", ""),
                still_path=ep.get("still_path"),
            ))
        return episodes

    async def get_tv_details(self, tv_id: int) -> dict:
        resp = await self._client.get(f"/tv/{tv_id}")
        resp.raise_for_status()
        return resp.json()

    async def get_movie_details(self, movie_id: int) -> dict:
        resp = await self._client.get(f"/movie/{movie_id}")
        resp.raise_for_status()
        return resp.json()

    async def close(self):
        await self._client.aclose()
