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

    async def get_tv_external_ids(self, tv_id):
        return {"imdb_id": "tt0903747", "tvdb_id": 81189}

    async def search_movie(self, query, year=None):
        return []

    async def search_tv(self, query, year=None):
        return []

    async def get_movie_details(self, movie_id):
        return {"id": movie_id, "title": "Inception",
                "belongs_to_collection": None, "imdb_id": "tt1375666"}


@pytest.fixture(autouse=True)
def stub_providers(monkeypatch, tmp_path):
    """Swap the module-level clients and clear the shared response cache so
    one test's stubbed answer can never leak into another.

    CINESORT_DATA_DIR is redirected at a tmp dir for the same reason and one
    more: matching now WRITES remembered picks (aliases.json), and a test suite
    must never leave anything in the developer's ~/.config/cinesort.
    config._config_dir() reads the variable on every call, so this takes effect
    immediately and only for this test.
    """
    provider_cache.clear()
    monkeypatch.setenv("CINESORT_DATA_DIR", str(tmp_path))
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


def subtitle_file(path="/media/tv/Breaking.Bad.S01E01.en.srt"):
    """What the scanner produces for a subtitle: detect() runs on it too, so it
    carries the same clean_name/season/episode a video does."""
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
    """Order matters: the plain match runs FIRST, because a pick is now
    remembered and would legitimately pin every match after it (F2)."""
    plain = run_match(files=[episode_file()], datasource="tmdb")
    row = plain["results"][0] if plain.get("results") else None
    if row is not None:
        assert row.get("pinned") is not True

    data = run_match(files=[episode_file()], datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad")
    assert data["results"][0]["pinned"] is True


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


# ── A provider year of the wrong TYPE must not 500 the whole batch ───────

def test_year_match_tolerates_a_string_year():
    """TMDb's show-details path hands back first_air_date[:4] — a STRING.
    Subtracting it from the file's int year raised TypeError inside
    year_match and 500'd the entire match: every file failed, and the manual
    override (which is what reaches that path) appeared to do nothing."""
    from app.core.matcher import year_match, cascade_breakdown
    assert year_match(2026, "2026") == 1.0
    assert year_match("2026", 2026) == 1.0
    assert year_match(2026, "not-a-year") == 0.0
    # The breakdown is what actually crashed — it must survive too.
    out = cascade_breakdown("Lucky", 1, 1, None, 2026, "Lucky",
                            meta_season=1, meta_episode=1, meta_year="2026")
    assert out["score"] > 0


def test_selected_show_year_reaches_scoring_as_an_int(monkeypatch):
    """Guard the source, not just the symptom: a show picked BY ID must put an
    int in show_data["year"], like every other producer does."""
    data = run_match(files=[dict(episode_file(), year=2008)], datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad")
    result = data["results"][0]
    assert result["matched"] is True
    year_rows = [c for c in result["score_detail"] if c["metric"] == "year"]
    assert year_rows, "the year metric must have contributed, not been skipped"


# ── F16: an explicit pick outranks detection, in both directions ──────────

def test_movie_pick_on_a_series_detected_file_is_honored():
    """The recovery path for a misdetected film: routing on media_type alone
    threw the pick away in exactly the case it exists for."""
    data = run_match(files=[episode_file(path="/media/tv/Deep4K.Inception.mkv")],
                     datasource="tmdb",
                     selected_movie_id="tt1375666", selected_movie_source="omdb")
    result = data["results"][0]
    assert result["matched"] is True
    assert result["pinned"] is True
    assert "Inception" in result["new_name"]


def test_show_pick_on_a_movie_detected_file_is_honored():
    """The mirror image — a series file with no SxE in its name is detected as
    a movie, and picking the show by id must route it to the series branch."""
    movie_detected = {"path": "/media/tv/Breaking.Bad.S01E01.mkv",
                      "filename": "Breaking.Bad.S01E01.mkv",
                      "media_type": "movie", "clean_name": "Breaking Bad",
                      "season": 1, "episode": 1, "year": None}
    data = run_match(files=[movie_detected], datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad")
    result = data["results"][0]
    assert result["matched"] is True
    assert "Pilot" in result["new_name"]


def test_no_pick_still_routes_on_detection():
    """Guard against the override leaking into ordinary matches."""
    data = run_match(files=[episode_file()], datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad")
    assert data["results"][0]["matched"] is True


# ── F6: a subtitle with no companion is matched on its own ───────────────
#
# The scanner already ran full detection on every subtitle, so a season of
# .srt files downloaded after the videos were renamed has everything it needs
# to match — it was simply never tried, and all twenty rows read "companion
# video not in this batch".

def test_a_lone_subtitle_matches_on_its_own():
    data = run_match(files=[subtitle_file()], datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad",
                     template="{name} - {s00e00} - {title}")
    result = data["results"][0]

    assert result["matched"] is True
    assert result["is_subtitle"] is True
    assert result["new_name"] == "Breaking Bad - S01E01 - Pilot.en.srt"


def test_a_companion_in_the_batch_still_wins():
    """Pairing runs first and is unchanged: a mixed batch must produce exactly
    the names it produced before this feature existed."""
    data = run_match(files=[episode_file(), subtitle_file()], datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad",
                     template="{name} - {s00e00} - {title}")
    by_name = {r["filename"]: r for r in data["results"]}
    video = by_name["Breaking.Bad.S01E01.mkv"]
    subtitle = by_name["Breaking.Bad.S01E01.en.srt"]

    assert subtitle["is_subtitle"] is True
    assert subtitle["new_path"] == video["new_path"].replace(".mkv", ".en.srt")
    # The subtitle inherits the video's score rather than scoring on its own.
    assert subtitle["score"] == video["score"]


def test_a_lone_subtitle_normalizes_its_language_tag():
    data = run_match(files=[subtitle_file("/media/tv/Breaking.Bad.S01E01.forced.eng.srt")],
                     datasource="tmdb", selected_show_id=1396,
                     selected_show_name="Breaking Bad",
                     template="{name} - {s00e00} - {title}")
    assert data["results"][0]["new_name"] == "Breaking Bad - S01E01 - Pilot.en.forced.srt"


def test_a_lone_subtitle_with_no_language_tag_keeps_a_clean_name():
    data = run_match(files=[subtitle_file("/media/tv/Breaking.Bad.S01E01.srt")],
                     datasource="tmdb", selected_show_id=1396,
                     selected_show_name="Breaking Bad",
                     template="{name} - {s00e00} - {title}")
    assert data["results"][0]["new_name"] == "Breaking Bad - S01E01 - Pilot.srt"


def test_ambiguous_subtitles_are_still_refused_rather_than_guessed():
    """Two quality doubles claiming the same episode: renaming the subtitle
    against either one would be a guess, so it stays skipped."""
    data = run_match(
        files=[episode_file("/media/tv/Breaking.Bad.S01E01.1080p.mkv"),
               episode_file("/media/tv/Breaking.Bad.S01E01.720p.mkv"),
               subtitle_file("/media/tv/Breaking.Bad.S01E01.different.release.en.srt")],
        datasource="tmdb", selected_show_id=1396, selected_show_name="Breaking Bad",
        template="{name} - {s00e00} - {title}")
    subtitle = next(r for r in data["results"] if r["filename"].endswith(".srt"))

    assert subtitle["matched"] is False
    assert "multiple videos match" in subtitle["reason"]


# ── F8: series carry their IMDb id ───────────────────────────────────────
#
# The binding was hardcoded empty, so every "[imdbid-…]" agent hint the README
# advertises collapsed to nothing for TV while working for films — the
# documented feature was a no-op for half the library.

def test_a_series_match_carries_its_imdb_id():
    data = run_match(files=[episode_file()], datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad",
                     template="{n} - {s00e00} [imdbid-{imdbid}]")
    assert data["results"][0]["new_name"] == "Breaking Bad - S01E01 [imdbid-tt0903747].mkv"


def test_the_hint_still_collapses_when_the_provider_has_no_id(monkeypatch):
    """A show TMDb has no external ids for must render the same clean name it
    always did — never a dangling "[imdbid-]"."""
    class NoIds(StubTMDb):
        async def get_tv_external_ids(self, tv_id):
            return {}

    monkeypatch.setattr(main, "tmdb", NoIds())
    data = run_match(files=[episode_file()], datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad",
                     template="{n} - {s00e00} [imdbid-{imdbid}]")
    assert data["results"][0]["new_name"] == "Breaking Bad - S01E01.mkv"


def test_a_failing_external_ids_call_never_fails_the_match(monkeypatch):
    """The id is a template convenience; losing a whole batch because an extra
    lookup timed out would trade a real feature for a cosmetic one."""
    class Broken(StubTMDb):
        async def get_tv_external_ids(self, tv_id):
            raise RuntimeError("network down")

    monkeypatch.setattr(main, "tmdb", Broken())
    data = run_match(files=[episode_file()], datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad",
                     template="{n} - {s00e00} - {t}")
    result = data["results"][0]
    assert result["matched"] is True
    assert result["new_name"] == "Breaking Bad - S01E01 - Pilot.mkv"


# ── F9: the extra TMDb record is fetched only when a template asks ───────
#
# get_movie_details costs ~91 ms on top of a ~142 ms search — +64% on every
# movie match. Nobody on the default Film preset should pay that for a token
# they never typed.

def test_movie_details_are_not_fetched_for_an_ordinary_template(monkeypatch):
    calls = []

    class Counting(StubTMDb):
        async def get_movie_details(self, movie_id):
            calls.append(movie_id)
            return await StubTMDb.get_movie_details(self, movie_id)

    monkeypatch.setattr(main, "tmdb", Counting())
    run_match(files=[movie_file(clean_name="xzqvw", year=1955)], datasource="tmdb",
              selected_movie_id="tt1375666", selected_movie_source="omdb",
              template="{n} ({y})")
    assert calls == []


@pytest.mark.parametrize("template", ["{collectionN}{n} ({y})", "{n} ({y}) [{collection}]",
                                      "{n} ({y}) [imdbid-{imdbid}]"])
def test_a_template_that_needs_the_record_triggers_the_fetch(template):
    assert main._template_needs_movie_details(template) is True


@pytest.mark.parametrize("template", ["{n} ({y})", "{n} ({y}){partN}", "{n} - {s00e00} - {t}"])
def test_an_ordinary_template_does_not(template):
    assert main._template_needs_movie_details(template) is False


def test_a_failing_details_call_never_fails_the_match(monkeypatch):
    class Broken(StubTMDb):
        async def get_movie_details(self, movie_id):
            raise RuntimeError("network down")

    monkeypatch.setattr(main, "tmdb", Broken())
    data = run_match(files=[movie_file(clean_name="xzqvw", year=1955)], datasource="tmdb",
                     selected_movie_id="tt1375666", selected_movie_source="omdb",
                     template="{collectionN}{n} ({y})")
    assert data["results"][0]["matched"] is True


# ── F12: the backend path a batch episode shift relies on ────────────────
#
# Anime rips carry ABSOLUTE numbers ("Show - 105.mkv") and some packs start at
# E00, so a whole season lands on the wrong episode. MatchRequest already
# honours per-file season/episode — the UI just had no way to rewrite them in
# bulk, so this pins the contract the Shift action depends on.

def test_shifted_episode_numbers_are_honoured():
    """What the UI posts after subtracting 100 from absolute numbering."""
    files = [dict(episode_file(path=f"/media/tv/Show.10{n}.mkv"), season=1, episode=n)
             for n in (1, 2)]
    data = run_match(files=files, datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad",
                     template="{n} - {s00e00} - {t}")

    assert [r["new_name"] for r in data["results"]] == [
        "Breaking Bad - S01E01 - Pilot.mkv", "Breaking Bad - S01E01 - Pilot.mkv"]


def test_a_shift_onto_a_nonexistent_episode_scores_far_below_the_gate():
    """A wrong shift does not fail loudly — the matcher still names the file
    from the nearest episode. What protects the user is the SCORE: the sxe
    metric goes negative, the result lands at ~0.2, and both the weak-match
    warning (0.4) and the auto-rename gate (0.6) catch it, so a watch folder
    will never act on it."""
    shifted = dict(episode_file(), season=5, episode=5)
    data = run_match(files=[shifted], datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad",
                     template="{n} - {s00e00} - {t}")
    result = data["results"][0]

    assert result["score"] < main.DEFAULT_LOW_CONFIDENCE
    sxe = next(c for c in result["score_detail"] if c["metric"] == "sxe")
    assert sxe["value"] < 0        # an explicit season/episode contradiction


def test_a_correct_shift_scores_at_the_top():
    """The contrast that makes the guard above meaningful."""
    data = run_match(files=[dict(episode_file(), season=1, episode=1)], datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad",
                     template="{n} - {s00e00} - {t}")
    assert data["results"][0]["score"] >= main.DEFAULT_REVIEW_CONFIDENCE


def test_an_absolute_number_does_not_override_the_shifted_pair():
    """shiftEpisodes clears `absolute` for exactly this reason: left in place
    it can out-vote the season/episode the user just corrected."""
    shifted = dict(episode_file(), season=1, episode=1, absolute=None)
    data = run_match(files=[shifted], datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad",
                     template="{n} - {s00e00} - {t}")
    assert data["results"][0]["new_name"] == "Breaking Bad - S01E01 - Pilot.mkv"
