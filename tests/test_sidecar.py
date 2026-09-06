"""Kodi/Jellyfin sidecar writing — the F7 seam.

Three properties matter more than the XML details:
  * a poster URL arrives from the BROWSER (it round-trips through the match
    result), so the host allow-list is an SSRF boundary, not a filter;
  * folder-level files (tvshow.nfo, poster.jpg) claim a whole directory, so
    they must only be written where the template actually made one;
  * an existing .nfo may be hand-corrected and is never overwritten.

No network: the only async test drives a stub transport.
"""

import asyncio
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.sidecar import (   # noqa: E402
    MAX_POSTER_BYTES, download_poster, poster_url, title_folder_for,
    write_episode_nfo, write_movie_nfo, write_nfos_for, write_tvshow_nfo,
)

MOVIE_META = {
    "title": "Inception",
    "original_title": "Inception",
    "year": 2010,
    "overview": "A thief who steals corporate secrets…",
    "poster": "https://image.tmdb.org/t/p/w154/poster.jpg",
    "tmdbid": 27205,
    "imdbid": "tt1375666",
}

EPISODE_META = {
    "show": "Breaking Bad",
    "show_year": 2008,
    "season": 1,
    "episode": 1,
    "title": "Pilot",
    "overview": "Walter White, a struggling chemistry teacher…",
    "air_date": "2008-01-20",
    "poster": "https://image.tmdb.org/t/p/w154/bb.jpg",
    "tmdbid": 1396,
    "imdbid": "",
}


# ── .nfo content ──────────────────────────────────────────────────────────

def test_movie_nfo_is_valid_xml_carrying_both_ids(tmp_path):
    video = tmp_path / "Inception (2010).mkv"
    written = write_movie_nfo(video, MOVIE_META)

    assert written == tmp_path / "Inception (2010).nfo"
    root = ET.parse(written).getroot()
    assert root.tag == "movie"
    assert root.findtext("title") == "Inception"
    assert root.findtext("year") == "2010"

    tmdb = root.find("uniqueid[@type='tmdb']")
    assert tmdb is not None and tmdb.text == "27205"
    assert tmdb.get("default") == "true"       # first id written is authoritative
    assert root.find("uniqueid[@type='imdb']").text == "tt1375666"


def test_movie_nfo_omits_empty_fields(tmp_path):
    """An empty <year/> asserts "this film has no year" and overrides the
    media server's own scraper — sparse matches must stay silent instead."""
    video = tmp_path / "Unknown.mkv"
    root = ET.parse(write_movie_nfo(video, {"title": "Unknown"})).getroot()
    assert root.findtext("year") is None
    assert root.find("uniqueid[@type='tmdb']") is None


def test_episode_nfo_carries_season_and_episode(tmp_path):
    video = tmp_path / "Breaking Bad - S01E01 - Pilot.mkv"
    root = ET.parse(write_episode_nfo(video, EPISODE_META)).getroot()

    assert root.tag == "episodedetails"
    assert root.findtext("season") == "1"
    assert root.findtext("episode") == "1"
    assert root.findtext("showtitle") == "Breaking Bad"
    assert root.findtext("aired") == "2008-01-20"
    # We hold the SHOW's id, not the episode's — asserting it here would be a
    # wrong identity, so no uniqueid is written at all.
    assert root.find("uniqueid") is None


def test_tvshow_nfo_lands_in_the_show_folder(tmp_path):
    root = ET.parse(write_tvshow_nfo(tmp_path, EPISODE_META)).getroot()
    assert root.tag == "tvshow"
    assert root.findtext("title") == "Breaking Bad"
    assert root.find("uniqueid[@type='tmdb']").text == "1396"


def test_existing_nfo_is_never_overwritten_without_force(tmp_path):
    video = tmp_path / "Inception (2010).mkv"
    nfo = tmp_path / "Inception (2010).nfo"
    nfo.write_text("<movie><title>Hand corrected</title></movie>", encoding="utf-8")

    assert write_movie_nfo(video, MOVIE_META) is None
    assert "Hand corrected" in nfo.read_text(encoding="utf-8")

    assert write_movie_nfo(video, MOVIE_META, force=True) == nfo
    assert "Hand corrected" not in nfo.read_text(encoding="utf-8")


def test_no_temp_files_survive(tmp_path):
    write_movie_nfo(tmp_path / "Inception (2010).mkv", MOVIE_META)
    assert not list(tmp_path.glob("*cinesort-tmp*"))


# ── Folder-level placement ────────────────────────────────────────────────

@pytest.mark.parametrize("path, title, depth, expected", [
    ("Breaking Bad/Season 1/ep.mkv", "Breaking Bad", 2, "Breaking Bad"),
    ("Breaking Bad (2008)/Season 1/ep.mkv", "Breaking Bad", 2, "Breaking Bad (2008)"),
    ("Breaking Bad (2008) [imdbid-tt0903747]/S1/ep.mkv", "Breaking Bad", 2,
     "Breaking Bad (2008) [imdbid-tt0903747]"),
    ("Law & Order SVU/Season 1/ep.mkv", "Law & Order: SVU", 2, "Law & Order SVU"),
    ("Inception (2010)/Inception (2010).mkv", "Inception", 1, "Inception (2010)"),
])
def test_title_folder_is_recognised(tmp_path, path, title, depth, expected):
    video = tmp_path / path
    assert title_folder_for(video, title, depth) == tmp_path / expected


@pytest.mark.parametrize("path, title, depth", [
    ("Breaking Bad - S01E01 - Pilot.mkv", "Breaking Bad", 2),       # Flat preset
    ("Breaking Bad Collection/Season 1/ep.mkv", "Breaking Bad", 2),  # near miss
    ("TV/Breaking Bad/Season 1/Specials/ep.mkv", "Breaking Bad", 2),  # too deep
    ("Movies/Inception (2010).mkv", "Inception", 1),
])
def test_no_title_folder_means_no_claim(tmp_path, path, title, depth):
    assert title_folder_for(tmp_path / path, title, depth) is None


def test_flat_layout_writes_the_episode_nfo_but_no_tvshow_nfo(tmp_path):
    """The Flat preset drops episodes into a shared root; tvshow.nfo there
    would tell the media server the whole library is one show."""
    video = tmp_path / "Breaking Bad - S01E01 - Pilot.mkv"
    written, errors = write_nfos_for(video, EPISODE_META)

    assert errors == []
    assert written == [tmp_path / "Breaking Bad - S01E01 - Pilot.nfo"]
    assert not (tmp_path / "tvshow.nfo").exists()


def test_folder_layout_writes_both(tmp_path):
    video = tmp_path / "Breaking Bad" / "Season 1" / "Breaking Bad - S01E01 - Pilot.mkv"
    video.parent.mkdir(parents=True)
    written, errors = write_nfos_for(video, EPISODE_META)

    assert errors == []
    assert set(written) == {video.with_suffix(".nfo"), tmp_path / "Breaking Bad" / "tvshow.nfo"}


# ── Poster URL handling ───────────────────────────────────────────────────

def test_poster_url_is_upsized_from_the_dialog_thumbnail():
    assert poster_url({"poster": "https://image.tmdb.org/t/p/w154/x.jpg"}) == \
        "https://image.tmdb.org/t/p/w342/x.jpg"
    assert poster_url({"poster": ""}) is None
    # Non-TMDb hosts are passed through unchanged.
    assert poster_url({"poster": "https://m.media-amazon.com/images/x.jpg"}) == \
        "https://m.media-amazon.com/images/x.jpg"


@pytest.mark.parametrize("url", [
    "https://evil.example/x.jpg",
    "https://image.tmdb.org.evil.example/x.jpg",   # suffix matching would pass this
    "http://image.tmdb.org/t/p/w342/x.jpg",        # plaintext
    "file:///etc/passwd",
    "https://127.0.0.1/x.jpg",
    "https://localhost:8888/api/settings",
])
def test_poster_download_refuses_disallowed_urls(tmp_path, url):
    async def go():
        async with httpx.AsyncClient() as client:
            await download_poster(url, tmp_path / "poster.jpg", client)

    with pytest.raises(ValueError):
        asyncio.run(go())
    assert not (tmp_path / "poster.jpg").exists()


def test_poster_download_writes_allowed_host(tmp_path):
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, content=b"\xff\xd8\xff\xe0 jpeg bytes")

    async def go():
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as client:
            return await download_poster(
                "https://image.tmdb.org/t/p/w342/x.jpg", tmp_path / "poster.jpg", client)

    written = asyncio.run(go())
    assert written == tmp_path / "poster.jpg"
    assert written.read_bytes().startswith(b"\xff\xd8")
    assert calls == ["https://image.tmdb.org/t/p/w342/x.jpg"]


def test_poster_download_is_capped_and_leaves_no_partial_file(tmp_path):
    def handler(request):
        return httpx.Response(200, content=b"x" * (MAX_POSTER_BYTES + 1))

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await download_poster(
                "https://image.tmdb.org/t/p/w342/x.jpg", tmp_path / "poster.jpg", client)

    with pytest.raises(ValueError):
        asyncio.run(go())
    assert list(tmp_path.iterdir()) == []


def test_existing_poster_is_left_alone(tmp_path):
    poster = tmp_path / "poster.jpg"
    poster.write_bytes(b"mine")

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(
                lambda r: httpx.Response(200, content=b"theirs"))) as client:
            return await download_poster(
                "https://image.tmdb.org/t/p/w342/x.jpg", poster, client)

    assert asyncio.run(go()) is None
    assert poster.read_bytes() == b"mine"


def test_poster_download_does_not_follow_redirects(tmp_path):
    """A 30x from an allow-listed host is the one way _check_poster_url could
    be walked past — httpx must not chase it to an internal address."""
    def handler(request):
        return httpx.Response(302, headers={"Location": "http://169.254.169.254/latest/meta-data/"})

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await download_poster(
                "https://image.tmdb.org/t/p/w342/x.jpg", tmp_path / "poster.jpg", client)

    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(go())
    assert list(tmp_path.iterdir()) == []
