"""IMDb tt-ID resolution across providers — the F8 seam.

The id reaches these clients from the user and goes into a query parameter, so
format validation happens before the request is built, not after.
"""

import asyncio
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.api.tvmaze import TVMazeClient, TVMazeShow   # noqa: E402

SHOW_JSON = {
    "id": 169, "name": "Breaking Bad", "premiered": "2008-01-20",
    "summary": "<p>A chemistry teacher…</p>", "status": "Ended",
    "genres": ["Drama"], "image": {"medium": "https://static.tvmaze.com/x.jpg"},
    "externals": {"imdb": "tt0903747", "thetvdb": 81189},
}


def client_with(handler) -> TVMazeClient:
    client = TVMazeClient()
    client._client = httpx.AsyncClient(base_url="https://api.tvmaze.com",
                                       transport=httpx.MockTransport(handler))
    return client


def test_lookup_returns_the_show_and_its_imdb_id():
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(200, json=SHOW_JSON)

    show = asyncio.run(client_with(handler).lookup_by_imdb("tt0903747"))
    assert isinstance(show, TVMazeShow)
    assert (show.id, show.name, show.year) == (169, "Breaking Bad", 2008)
    assert show.imdb_id == "tt0903747"
    assert seen == ["https://api.tvmaze.com/lookup/shows?imdb=tt0903747"]


def test_an_unknown_id_is_none_not_an_error():
    """404 is TVmaze's documented "no such show" answer."""
    handler = lambda request: httpx.Response(404, text="Not Found")
    assert asyncio.run(client_with(handler).lookup_by_imdb("tt9999999")) is None


def test_a_server_error_still_raises():
    handler = lambda request: httpx.Response(500, text="boom")
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(client_with(handler).lookup_by_imdb("tt0903747"))


@pytest.mark.parametrize("bad", ["", "0903747", "tt12", "tt0903747/../shows/1",
                                 "tt0903747&x=1", "nope"])
def test_a_malformed_id_never_reaches_the_wire(bad):
    def handler(request):
        raise AssertionError(f"request made for {bad!r}")

    with pytest.raises(ValueError):
        asyncio.run(client_with(handler).lookup_by_imdb(bad))


def test_search_results_carry_the_imdb_id_too():
    handler = lambda request: httpx.Response(200, json=[{"show": SHOW_JSON}])
    shows = asyncio.run(client_with(handler).search_shows("breaking bad"))
    assert shows[0].imdb_id == "tt0903747"


def test_a_show_without_externals_is_not_a_crash():
    bare = {k: v for k, v in SHOW_JSON.items() if k != "externals"}
    handler = lambda request: httpx.Response(200, json=bare)
    show = asyncio.run(client_with(handler).get_show(169))
    assert show.imdb_id is None


def test_the_documented_301_redirect_is_followed():
    """TVmaze answers /lookup/shows with 301 → /shows/{id}. httpx does not
    follow redirects by default, so the first cut of this raised on every
    successful lookup — caught only by hitting the real API."""
    seen = []

    def handler(request):
        seen.append(request.url.path)
        if request.url.path == "/lookup/shows":
            return httpx.Response(301, headers={"Location": "https://api.tvmaze.com/shows/169"})
        return httpx.Response(200, json=SHOW_JSON)

    show = asyncio.run(client_with(handler).lookup_by_imdb("tt0903747"))
    assert show.id == 169
    assert seen == ["/lookup/shows", "/shows/169"]


def test_a_redirect_off_the_api_host_is_refused():
    """Following redirects is what makes a response able to steer the request.
    It stays inside api.tvmaze.com or it fails."""
    def handler(request):
        if request.url.path == "/lookup/shows":
            return httpx.Response(301, headers={"Location": "https://evil.example/shows/1"})
        return httpx.Response(200, json=SHOW_JSON)

    with pytest.raises(RuntimeError, match="redirected off-site"):
        asyncio.run(client_with(handler).lookup_by_imdb("tt0903747"))
