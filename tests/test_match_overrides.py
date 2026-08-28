"""Manual-override guards — the F4/F5 seam.

The `pinned` flag is the contract between "the pipeline guessed this" and "the
user chose this by id". It exists because an explicit pick honest-scored at
0.049 was refused outright (F4), and because rows that survived that were then
silently deselected by the confidence gate on the next Match click (F5).

No network: the provider clients are replaced with stubs, so these run offline
and identically on every platform.
"""

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.cache import provider_cache   # noqa: E402
import app.main as main                     # noqa: E402


# ── Stubs standing in for TMDb / OMDb ─────────────────────────────────────

class StubOMDbResult:
    def __init__(self):
        self.imdb_id = "tt1375666"
        self.title = "Inception"
        self.year = 2010
        self.overview = "A thief who steals corporate secrets…"
        self.poster_url = "https://example.invalid/poster.jpg"
        self.media_type = "movie"
        self.imdb_rating = 8.8


class StubOMDb:
    enabled = True

    async def get_by_imdb_id(self, imdb_id):
        return StubOMDbResult()

    async def search_movie(self, query, year=None):
        return []


class StubTMDbEpisode:
    def __init__(self, season, episode, title):
        self.season, self.episode, self.title = season, episode, title
        self.air_date = "2008-01-20"
        self.overview = ""


class StubTMDb:
    enabled = True

    async def get_tv_details(self, tv_id):
        return {"name": "Breaking Bad", "first_air_date": "2008-01-20",
                "poster_path": "/p.jpg", "seasons": [{"season_number": 1}]}

    async def get_tv_season(self, tv_id, season):
        return [StubTMDbEpisode(1, 1, "Pilot")]

    async def search_movie(self, query, year=None):
        return []

    async def search_tv(self, query, year=None):
        return []


@pytest.fixture(autouse=True)
def stub_providers(monkeypatch):
    """Swap the module-level clients and clear the shared response cache so
    one test's stubbed answer can never leak into another."""
    provider_cache.clear()
    monkeypatch.setattr(main, "tmdb", StubTMDb())
    monkeypatch.setattr(main, "omdb", StubOMDb())
    yield
    provider_cache.clear()


def run_match(**kwargs):
    """Call the real matching pipeline with a private progress dict."""
    request = main.MatchRequest(**kwargs)
    return asyncio.run(main._match_files_impl(request, progress={}))


def movie_file(clean_name="tt9887687", year=None, path="/media/movies/tt9887687.mkv"):
    return {"path": path, "filename": Path(path).name, "media_type": "movie",
            "clean_name": clean_name, "year": year}


def episode_file(path="/media/tv/Breaking.Bad.S01E01.mkv"):
    return {"path": path, "filename": Path(path).name, "media_type": "series",
            "clean_name": "Breaking Bad", "season": 1, "episode": 1, "year": None}


# ── F4: an explicit pick must never be refused by the scoring floor ───────

def test_exact_movie_pick_matches_despite_a_conflicting_year():
    """The filename resembles nothing and carries a year that contradicts the
    picked record, so every metric scores 0. Before the fix this fell through
    to "No close match", discarding the choice the user had just made."""
    data = run_match(files=[movie_file(clean_name="xzqvw", year=1955)],
                     datasource="tmdb",
                     selected_movie_id="tt1375666", selected_movie_source="omdb")
    result = data["results"][0]

    assert result["matched"] is True
    assert result["pinned"] is True
    assert result["new_name"] == "Inception (2010).mkv"
    # The score stays honest — the flag carries the consent, not the evidence.
    assert result["score"] < 0.4


def test_exact_movie_pick_is_flagged_pinned():
    data = run_match(files=[movie_file()], datasource="tmdb",
                     selected_movie_id="tt1375666", selected_movie_source="omdb")
    assert data["results"][0]["pinned"] is True


def test_series_pick_by_show_id_is_flagged_pinned():
    data = run_match(files=[episode_file()], datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad")
    result = data["results"][0]
    assert result["matched"] is True
    assert result["pinned"] is True
    assert result["new_name"] == "Breaking Bad - S01E01 - Pilot.mkv"


# ── The flag must NOT appear on ordinary guesses ──────────────────────────

def test_auto_matched_series_is_not_pinned():
    data = run_match(files=[episode_file()], datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad")
    assert data["results"][0]["pinned"] is True

    plain = run_match(files=[episode_file()], datasource="tmdb")
    row = plain["results"][0] if plain.get("results") else None
    if row is not None:
        assert row.get("pinned") is not True


def test_unmatched_rows_carry_no_pinned_flag():
    """Nothing was chosen and nothing matched — the flag must be absent, not
    False-y-by-accident, so the frontend gate treats it as an ordinary miss."""
    data = run_match(files=[movie_file(clean_name="nothing will match this")],
                     datasource="tmdb")
    result = data["results"][0]
    assert result["matched"] is False
    assert "pinned" not in result


# ── Subtitles inherit consent along with the score ────────────────────────

def test_subtitle_companion_inherits_pinned_from_its_video():
    """A subtitle carries no evidence of its own — it is renamed BECAUSE its
    video was. Without inheritance the gate keeps a pinned low-score video
    selected and drops its .srt, renaming the video and orphaning the subtitle
    beside it under the old name."""
    video = movie_file(path="/media/movies/tt9887687.mkv")
    subtitle = movie_file(path="/media/movies/tt9887687.en.srt")
    data = run_match(files=[video, subtitle], datasource="tmdb",
                     selected_movie_id="tt1375666", selected_movie_source="omdb")

    by_name = {r["filename"]: r for r in data["results"]}
    assert by_name["tt9887687.mkv"]["pinned"] is True
    assert by_name["tt9887687.en.srt"]["matched"] is True
    assert by_name["tt9887687.en.srt"]["pinned"] is True


def test_generated_names_respect_the_filesystem_byte_limit():
    """End-to-end guard for F7: whatever the template asks for, no component
    the rename will attempt may exceed 255 bytes."""
    data = run_match(files=[movie_file()], datasource="tmdb",
                     template="{n} " * 40,
                     selected_movie_id="tt1375666", selected_movie_source="omdb")
    for part in Path(data["results"][0]["new_path"]).parts:
        assert len(part.encode("utf-8")) <= 255


# ── Known gap, documented rather than silently tolerated ──────────────────

@pytest.mark.xfail(reason="A file DETECTED as series but picked as a movie by id is "
                          "still ignored: selected_movie_id is only honored inside the "
                          "movie branch of _match_files_impl. Reachable when detection "
                          "misclassifies a movie (see F15), where the manual override "
                          "is exactly the recovery the user needs.",
                   strict=True)
def test_movie_pick_on_a_series_detected_file_is_honored():
    data = run_match(files=[episode_file(path="/media/tv/Deep4K.Inception.mkv")],
                     datasource="tmdb",
                     selected_movie_id="tt1375666", selected_movie_source="omdb")
    assert data["results"][0]["matched"] is True
