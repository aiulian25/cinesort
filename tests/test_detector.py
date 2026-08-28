"""Detection guards — the filename→title seam where F8 and F15 live.

Every case here is a real filename shape, not a synthetic one: the review that
prompted these tests measured a heavy-noise release scoring 0.597 against its
own exact title, which slipped under the 0.6 plausibility floor and let TMDb
list order pick the wrong remake year.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.detector import MediaType, clean_name, detect  # noqa: E402
from app.core.matcher import name_similarity                 # noqa: E402


# ── The four names from the review ────────────────────────────────────────

@pytest.mark.parametrize("filename, expected_clean, expected_year", [
    # Reported case, with the year present.
    ("Masters.of.the.Universe.2026.Hybrid.2160p.WEB-DL.DV.HDR.DDP5.1.Atmos.H265-AOC.mkv",
     "Masters of the Universe", 2026),
    # Same release with no year: the noise used to survive into the query.
    ("Masters.of.the.Universe.Hybrid.2160p.WEB-DL.DV.HDR.DDP5.1.Atmos.H265-AOC.mkv",
     "Masters of the Universe", None),
    # A bare IMDb-id stem — nothing to detect, must not invent anything.
    ("tt9887687.mkv", "tt9887687", None),
    # Long multi-clause title must survive intact.
    ("The.Lord.of.the.Rings.The.War.of.the.Rohirrim.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv",
     "The Lord of the Rings The War of the Rohirrim", 2024),
])
def test_review_filenames(filename, expected_clean, expected_year):
    det = detect(Path("/media/movies") / filename)
    assert det.clean_name == expected_clean
    assert det.year == expected_year
    assert det.media_type is MediaType.MOVIE


def test_heavy_noise_title_scores_high_enough_to_prompt():
    """F8: the measured failure was 0.597 — under the 0.6 remake-prompt floor,
    so the prompt was skipped and a 1987/2026 tie broke on provider order."""
    noisy = ("Masters.of.the.Universe.GERMAN.DL.MULTi.Hybrid.2160p."
             "WEB-DL.HDR10Plus.DV.HEVC-AOC.mkv")
    similarity = name_similarity(clean_name(noisy), "Masters of the Universe")
    assert similarity >= 0.6, f"regressed below the remake-prompt floor: {similarity}"


# ── One case per noise token added in Step 7 ──────────────────────────────

@pytest.mark.parametrize("filename", [
    "Some.Title.Hybrid.1080p.WEB-DL.mkv",
    "Some.Title.REMUX.2160p.BluRay.mkv",
    "Some.Title.HDR10Plus.2160p.WEB-DL.mkv",
    "Some.Title.HDR10.2160p.WEB-DL.mkv",
    "Some.Title.GERMAN.DL.1080p.BluRay.mkv",
    "Some.Title.iTALiAN.BDRip.mkv",
    "Some.Title.VOSTFR.1080p.WEB.mkv",
    "Some.Title.TRUEFRENCH.1080p.BluRay.mkv",
    "Some.Title.SUBBED.720p.HDTV.mkv",
])
def test_release_noise_is_stripped(filename):
    assert clean_name(filename) == "Some Title"


# ── Guards: the same regexes must not eat real titles ─────────────────────

@pytest.mark.parametrize("filename, expected", [
    # Language words inside genuine titles — the reason those patterns are
    # case-SENSITIVE. Case-insensitively these become "The Job", "Kiss"…
    ("The.Italian.Job.2003.1080p.BluRay.x264-AMIABLE.mkv", "The Italian Job"),
    ("The.French.Connection.1971.1080p.BluRay-GROUP.mkv", "The French Connection"),
    ("The.Danish.Girl.2015.1080p.WEB-DL.mkv", "The Danish Girl"),
    ("French.Kiss.1995.1080p.mkv", "French Kiss"),
    # Hyphenated titles — the reason the trailing-group strip is guarded.
    # Unguarded it yields "Spider", "Ant", "X", "Mad Max" → "Mad".
    ("Spider-Man.mkv", "Spider Man"),
    ("Ant-Man.2015.1080p.BluRay-GROUP.mkv", "Ant Man"),
    ("X-Men.Days.of.Future.Past.2014.1080p.mkv", "X Men Days of Future Past"),
    ("Mad-Max.Fury.Road.2015.1080p.BluRay-GRP.mkv", "Mad Max Fury Road"),
    ("Wall-E.2008.1080p.BluRay.mkv", "Wall E"),
])
def test_real_titles_survive_cleaning(filename, expected):
    assert clean_name(filename) == expected


def test_trailing_group_stripped_only_for_scene_releases():
    """A no-year scene release loses its ALL-CAPS group; a bare hyphenated
    title keeps every word."""
    assert clean_name("Spider-Man.1080p.BluRay-SPARKS.mkv") == "Spider Man"
    assert clean_name("Spider-Man.mkv") == "Spider Man"


# ── Detection of the other media shapes must not regress ──────────────────

@pytest.mark.parametrize("filename, media_type, season, episode", [
    ("Breaking.Bad.S01E01.1080p.BluRay.x264-GROUP.mkv", MediaType.SERIES, 1, 1),
    ("The.Wire.S03E05.720p.HDTV.mkv", MediaType.SERIES, 3, 5),
    ("Show.Name.1x05.HDTV.XviD-FQM.avi", MediaType.SERIES, 1, 5),
])
def test_series_detection(filename, media_type, season, episode):
    det = detect(Path("/media/tv") / filename)
    assert det.media_type is media_type
    assert (det.episode_info.season, det.episode_info.episode) == (season, episode)


def test_anime_absolute_numbering():
    det = detect(Path("/media/anime/[HorribleSubs] Anime Title - 42 [1080p].mkv"))
    assert det.episode_info.absolute == 42
    assert det.clean_name == "Anime Title"


def test_daily_show_date():
    det = detect(Path("/media/tv/The.Daily.Show.2024.03.05.1080p.WEB.mkv"))
    assert det.episode_info.date == "2024-03-05"
    assert det.clean_name == "The Daily Show"


def test_music_is_not_run_through_the_video_pipeline():
    det = detect(Path("/media/music/Artist - 03 - Song Title.mp3"))
    assert det.media_type is MediaType.MUSIC
    assert (det.artist, det.track, det.title) == ("Artist", 3, "Song Title")


# ── A release year must not end up inside the SEARCH TITLE ────────────────

@pytest.mark.parametrize("filename, expected_clean, expected_year", [
    # Reported live: "Lucky 2026" made TMDb fuzzy-return only "Lucky Luke",
    # a single result — so the wrong show was auto-picked with no prompt.
    ("Lucky.2026.S01E01.No.Shortcuts.2160p.ATVP.WEB-DL.mkv", "Lucky", 2026),
    ("Doctor.Who.2005.S01E01.720p.HDTV.mkv", "Doctor Who", 2005),
    ("The.4400.2021.S01E02.1080p.mkv", "The 4400", 2021),
])
def test_series_release_year_is_not_part_of_the_title(filename, expected_clean, expected_year):
    det = detect(Path("/media/tv") / filename)
    assert det.clean_name == expected_clean
    assert det.year == expected_year        # still available as the search filter


def test_a_show_titled_as_a_year_keeps_its_name():
    """Stripping a trailing year must not erase "1923" or "1883"."""
    assert detect(Path("/media/tv/1923.S01E01.1080p.WEB.mkv")).clean_name == "1923"


# ── A number IN THE TITLE must not be mistaken for the release year ───────

@pytest.mark.parametrize("filename, expected_clean, expected_year", [
    # YEAR_PATTERN matches any (19|20)\d{2}, so these numbers all look like
    # years. Picking the first match blindly cost the film its name: "1917",
    # "2046" and "2012" cleaned to an EMPTY title (which then fell back to the
    # parent folder), and "Blade Runner 2049" lost both its number and its
    # real year.
    ("Blade.Runner.2049.2017.2160p.UHD.BluRay.x265.mkv", "Blade Runner 2049", 2017),
    ("1917.2019.1080p.BluRay.x264-GROUP.mkv", "1917", 2019),
    ("2046.2004.1080p.BluRay.mkv", "2046", 2004),
    ("2012.2009.1080p.BluRay.x264.mkv", "2012", 2009),
    ("1984.1984.1080p.BluRay.mkv", "1984", 1984),
])
def test_title_numbers_are_not_treated_as_the_release_year(filename, expected_clean, expected_year):
    det = detect(Path("/media/movies") / filename)
    assert det.clean_name == expected_clean
    assert det.year == expected_year


def test_clean_name_and_extract_year_agree_on_which_year():
    """If they disagree the title keeps a year the provider search never
    filters by — the exact shape of the Blade Runner 2049 failure."""
    from app.core.detector import clean_name, extract_year
    f = "Blade.Runner.2049.2017.2160p.UHD.BluRay.x265.mkv"
    assert extract_year(f) == 2017
    assert "2049" in clean_name(f) and "2017" not in clean_name(f)


# ── Known-bad, documented rather than silently tolerated ──────────────────

@pytest.mark.xfail(reason="F15: SXE_PATTERNS[6] '(?:EP|Episode)' has no left word "
                          "boundary, so 'step4'/'Deep4'/'sleep12' parse as Episode N. "
                          "classify_file() also consults the parent folder, so one "
                          "badly-named folder misclassifies every movie inside it.",
                   strict=True)
def test_ep_must_not_match_inside_a_word():
    assert detect(Path("/media/Deep4K/Inception.2010.mkv")).media_type is MediaType.MOVIE
