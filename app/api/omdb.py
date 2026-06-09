"""
OMDb API client — Open Movie Database (IMDb data wrapper).
Free tier: 1,000 requests/day. No adult-content filtering.
Get a free key at https://www.omdbapi.com/apikey.aspx
Set OMDB_API_KEY env var to activate; without it the client is disabled.
"""

import os
import httpx
from dataclasses import dataclass, field
from typing import Optional


API_BASE = "https://www.omdbapi.com"


@dataclass
class OMDbResult:
    imdb_id: str
    title: str
    year: Optional[int] = None
    overview: str = ""
    poster_url: Optional[str] = None
    media_type: str = "movie"   # "movie" | "series" | "episode"
    imdb_rating: Optional[float] = None
    genres: list[str] = field(default_factory=list)


class OMDbClient:
    def __init__(self, api_key: Optional[str] = None):
        key = api_key or os.getenv("OMDB_API_KEY", "")
        self.enabled = bool(key)
        self._api_key = key
        self._client = httpx.AsyncClient(
            base_url=API_BASE,
            timeout=12.0,
            headers={"Accept": "application/json"},
        )

    # ── Search by title ────────────────────────────────────────────────
    async def search_movie(
        self,
        query: str,
        year: Optional[int] = None,
    ) -> list[OMDbResult]:
        """
        Search by title using the OMDb ?s= endpoint.
        Returns up to 10 results. Does NOT filter adult content.
        """
        if not self.enabled:
            return []

        params: dict[str, str] = {
            "apikey": self._api_key,
            "s": query,
            "type": "movie",
        }
        if year:
            params["y"] = str(year)

        resp = await self._client.get("/", params=params)
        resp.raise_for_status()
        data = resp.json()

        if data.get("Response") != "True":
            return []

        results: list[OMDbResult] = []
        for item in data.get("Search", []):
            raw_year = item.get("Year", "") or ""
            # Year can be "1978" or "1978–1980" — take the first 4 digits
            parsed_year: Optional[int] = None
            if raw_year and raw_year[:4].isdigit():
                parsed_year = int(raw_year[:4])

            poster = item.get("Poster") or ""
            results.append(OMDbResult(
                imdb_id=item.get("imdbID", ""),
                title=item.get("Title", ""),
                year=parsed_year,
                media_type=item.get("Type", "movie"),
                poster_url=poster if poster.startswith("http") else None,
            ))

        return results

    # ── Lookup by IMDb ID ──────────────────────────────────────────────
    async def get_by_imdb_id(self, imdb_id: str) -> Optional[OMDbResult]:
        """
        Exact lookup by IMDb tt-ID (e.g. "tt0077415").
        Useful as a manual override when title-search fails.
        """
        if not self.enabled:
            return None

        # Validate the IMDb ID format before sending it to the API
        # to prevent any injection / unexpected requests
        import re
        if not re.fullmatch(r"tt\d{7,8}", imdb_id):
            raise ValueError(f"Invalid IMDb ID format: {imdb_id!r}")

        params = {"apikey": self._api_key, "i": imdb_id, "plot": "short"}
        resp = await self._client.get("/", params=params)
        resp.raise_for_status()
        data = resp.json()

        if data.get("Response") != "True":
            return None

        raw_year = data.get("Year", "") or ""
        parsed_year: Optional[int] = None
        if raw_year and raw_year[:4].isdigit():
            parsed_year = int(raw_year[:4])

        rating_str = data.get("imdbRating") or ""
        try:
            rating = float(rating_str) if rating_str not in ("N/A", "") else None
        except ValueError:
            rating = None

        genres = [g.strip() for g in (data.get("Genre") or "").split(",") if g.strip()]
        poster = data.get("Poster") or ""

        return OMDbResult(
            imdb_id=data.get("imdbID", imdb_id),
            title=data.get("Title", ""),
            year=parsed_year,
            overview=data.get("Plot", "") or "",
            poster_url=poster if poster.startswith("http") else None,
            media_type=data.get("Type", "movie"),
            imdb_rating=rating,
            genres=genres,
        )

    async def close(self):
        await self._client.aclose()
