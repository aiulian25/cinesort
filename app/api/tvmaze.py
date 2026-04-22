"""
TVmaze API client — completely free, no API key required.
https://www.tvmaze.com/api
"""

import httpx
from dataclasses import dataclass
from typing import Optional


API_BASE = "https://api.tvmaze.com"


@dataclass
class TVMazeShow:
    id: int
    name: str
    year: Optional[int] = None
    summary: str = ""
    image_url: Optional[str] = None
    status: str = ""
    genres: list[str] = None

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
            ))
        return results

    async def get_episodes(self, show_id: int) -> list[TVMazeEpisode]:
        resp = await self._client.get(f"/shows/{show_id}/episodes")
        resp.raise_for_status()
        data = resp.json()
        episodes = []
        for ep in data:
            episodes.append(TVMazeEpisode(
                season=ep.get("season", 0),
                episode=ep.get("number", 0) or 0,
                title=ep.get("name", ""),
                air_date=ep.get("airdate"),
                summary=ep.get("summary", "") or "",
            ))
        return episodes

    async def get_show(self, show_id: int) -> TVMazeShow:
        resp = await self._client.get(f"/shows/{show_id}")
        resp.raise_for_status()
        show = resp.json()
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
        )

    async def close(self):
        await self._client.aclose()
