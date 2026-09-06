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

from app.core.detector import (   # noqa: E402
    MediaType, clean_name, detect, extract_part, extract_subtitle_lang_tag,
    parse_music_info,
    infer_from_folders, is_sample_or_extra, normalize_subtitle_tag,
    parse_episode_info, season_from_folder,
)
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


# ── F15: "ep"/"sp" must not match inside a word ───────────────────────────
#
# Both patterns lacked a left boundary, so any title containing "ep" or "sp"
# followed by digits parsed as an episode. classify_file() reads the PARENT
# FOLDER too, which turned one badly-named folder into a series label for
# every film inside it — and a film matched as a series never renames.

@pytest.mark.parametrize("name", [
    "Deep4K", "Deep.4K", "Step4", "sleep12", "Grep99", "Deep4K Rips",
    "Sleep.2023.1080p.WEB-DL",          # a real 2023 film, read as "Episode 2023"
    "Gasp.2019.1080p", "Crisp.2.2019", "Grasp.1.2020",   # pattern 9, "sp" mid-word
])
def test_ep_and_sp_do_not_match_inside_a_word(name):
    assert parse_episode_info(name) is None


@pytest.mark.parametrize("name", [
    "Show.EP01", "Show EP 02", "Show_ep03", "Episode 5 - Title",
    "Show.Episode.12", "Show.SP01", "Show - SP 02",
])
def test_separated_ep_and_sp_still_parse(name):
    assert parse_episode_info(name) is not None


def test_a_folder_named_deep4k_does_not_make_its_films_series():
    assert detect(Path("/media/Deep4K/Inception.2010.mkv")).media_type is MediaType.MOVIE
    assert detect(Path("/media/Movies/Sleep.2023.1080p.mkv")).media_type is MediaType.MOVIE


# ── F4: release samples and media-server extras ───────────────────────────
#
# A scene sample is the same title at 30-60 seconds: it matches the SAME
# record as the feature, so it either collides with it as a
# duplicate_destination or renames OVER it when the feature is not in the
# batch. The exclusion has to be narrow enough not to eat real films whose
# titles contain the word.

@pytest.mark.parametrize("path", [
    "/m/Movie.2010-GRP.sample.mkv",
    "/m/Movie.2010-sample.mkv",
    "/m/sample.mkv",
    "/m/Sample/sample.mkv",
    "/m/Movie (2010)/Featurettes/making-of.mkv",
    "/m/Movie (2010)/Extras/Deleted Scenes/cut.mkv",
    "/m/Show/Season 1/Trailers/teaser.mkv",
])
def test_samples_and_extras_are_recognised(path):
    assert is_sample_or_extra(Path(path)) is True


@pytest.mark.parametrize("path", [
    "/m/Movie (2010)/Movie.2010.mkv",
    "/m/Sample.This.2015.1080p.mkv",        # a real 2015 film
    "/m/Free.Samples.2012.1080p.mkv",       # a real 2012 film
    "/m/Movie (2010)/Sample Size.2020.mkv",
])
def test_real_titles_containing_the_word_are_kept(path):
    assert is_sample_or_extra(Path(path)) is False


def test_the_scanned_folder_itself_is_never_treated_as_extras():
    """Pointing the scanner AT an extras folder is an explicit instruction —
    only directories BELOW the scan root may exclude a file."""
    video = Path("/m/Movie (2010)/Featurettes/making-of.mkv")
    assert is_sample_or_extra(video, root=Path("/m/Movie (2010)/Featurettes")) is False
    assert is_sample_or_extra(video, root=Path("/m/Movie (2010)")) is True


def test_extras_are_caught_at_any_depth_below_the_root():
    assert is_sample_or_extra(Path("/m/TV/Show/Season 1/Extras/a/b/x.mkv"),
                              root=Path("/m/TV")) is True


# ── F1: folder-aware detection ────────────────────────────────────────────
#
# Plex/Jellyfin/Sonarr layouts put the title in the FOLDER and leave the
# filename carrying nothing but an episode number. Before this, every episode
# of such a season became its own one-file group named "Season 01" or "E01" —
# and a bare "E01.mkv" was classified as a MOVIE, which no manual pick could
# rescue.

@pytest.mark.parametrize("name, expected", [
    ("Season 01", 1), ("Season 1", 1), ("season 7", 7),
    ("S02", 2), ("Staffel 3", 3), ("Saison 2", 2), ("Temporada 5", 5),
    ("Specials", 0), ("Special", 0),
    ("Breaking Bad", None), ("Disc 1", None), ("Season", None), ("S", None),
])
def test_season_folder_names(name, expected):
    assert season_from_folder(name) == expected


@pytest.mark.parametrize("path, expected", [
    ("/media/tv/Breaking Bad (2008)/Season 01/S01E01.mkv", ("Breaking Bad", 2008, 1)),
    ("/media/tv/Breaking Bad/Season 1/E01.mkv", ("Breaking Bad", None, 1)),
    ("/media/tv/Doctor Who (2005)/Season 4/Disc 1/E03.mkv", ("Doctor Who", 2005, 4)),
    ("/media/tv/Show/Specials/S00E01.mkv", ("Show", None, 0)),
    ("/media/movies/Inception (2010)/Inception.2010.mkv", ("Inception", 2010, None)),
])
def test_infer_from_folders_reads_the_layout(path, expected):
    assert infer_from_folders(Path(path)) == expected


@pytest.mark.parametrize("path", ["/downloads/E01.mkv", "/media/tv/E01.mkv",
                                  "/media/Movies/01.mkv", "/srv/incoming/E01.mkv"])
def test_a_library_root_is_never_adopted_as_a_show_title(path):
    """"Downloads" is not a series. Naming one after the folder every
    unrelated file also sits in would group the whole staging area together."""
    assert infer_from_folders(Path(path))[0] is None


@pytest.mark.parametrize("path, name, year, season, episode", [
    ("/media/tv/Breaking Bad (2008)/Season 01/S01E01 - Pilot.mkv", "Breaking Bad", 2008, 1, 1),
    ("/media/tv/Breaking Bad/Season 1/E01.mkv", "Breaking Bad", None, 1, 1),
    ("/media/tv/Breaking Bad/Season 1/01.mkv", "Breaking Bad", None, 1, 1),
    ("/media/tv/Show Name/Staffel 3/E07.mkv", "Show Name", None, 3, 7),
    ("/media/tv/Show/S02/E11.mkv", "Show", None, 2, 11),
    ("/media/tv/Doctor Who (2005)/Season 4/Disc 1/E03.mkv", "Doctor Who", 2005, 4, 3),
    ("/media/tv/Show/Specials/S00E01.mkv", "Show", None, 0, 1),
])
def test_folder_layout_supplies_show_and_season(path, name, year, season, episode):
    result = detect(Path(path))
    assert result.media_type is MediaType.SERIES
    assert result.clean_name == name
    assert result.year == year
    assert (result.episode_info.season, result.episode_info.episode) == (season, episode)


@pytest.mark.parametrize("path, name, year", [
    ("/media/movies/Inception (2010)/Inception.2010.1080p.mkv", "Inception", 2010),
    ("/media/movies/Blade Runner 2049 (2017)/Blade.Runner.2049.2017.mkv", "Blade Runner 2049", 2017),
    ("/media/movies/300.mkv", "300", None),
    ("/media/movies/21.mkv", "21", None),
    ("/media/movies/Movies 2023/Some.Film.mkv", "Some Film", None),
])
def test_movies_are_untouched_by_the_folder_walk(path, name, year):
    """A bare number is an episode only inside a season folder — read anywhere
    else, "300" is a film, and "Movies 2023" must not lend it a year."""
    result = detect(Path(path))
    assert result.media_type is MediaType.MOVIE
    assert result.clean_name == name
    assert result.year == year
    assert result.episode_info is None


def test_a_named_episode_keeps_its_own_title():
    """The folder only fills a gap; it never overrides a filename that has a
    title of its own."""
    result = detect(Path("/media/tv/Wrong Folder Name/Season 1/Breaking Bad - S01E01 - Pilot.mkv"))
    assert result.clean_name == "Breaking Bad"


# ── F3: multi-part movies ─────────────────────────────────────────────────
#
# Two halves of one film render the SAME destination, so one of them ends up
# skipped or named "Movie (2010) (2).mkv" — which no media server stacks back
# into a single entry.

@pytest.mark.parametrize("filename, part", [
    ("Movie.2010.CD1.mkv", 1),
    ("Movie.2010.CD2.mkv", 2),
    ("Movie.2010.Part1.mkv", 1),
    ("Movie.2010.pt2.mkv", 2),
    ("Movie.2010.Disc.1.mkv", 1),
    ("Movie.2010.Disk 2.mkv", 2),
    ("Movie.CD1.mkv", 1),          # no year: CD is never a title word
    ("Movie.2010.1080p.mkv", None),
])
def test_part_detection(filename, part):
    result = detect(Path("/media/movies/" + filename))
    assert result.part == part
    assert result.clean_name == "Movie"
    assert result.media_type is MediaType.MOVIE


@pytest.mark.parametrize("filename, expected_name", [
    # "Part N" BEFORE the year belongs to the title — this is the name TMDb
    # knows, and stripping it would hand the search a worse query.
    ("Harry.Potter.and.the.Deathly.Hallows.Part.1.2010.1080p.mkv",
     "Harry Potter and the Deathly Hallows Part 1"),
    ("Harry Potter and the Deathly Hallows Part 2 (2011).mkv",
     "Harry Potter and the Deathly Hallows Part 2"),
    ("Movie.Part1.mkv", "Movie Part1"),   # no year to separate them
])
def test_part_in_a_title_is_left_alone(filename, expected_name):
    result = detect(Path("/media/movies/" + filename))
    assert result.part is None
    assert result.clean_name == expected_name


@pytest.mark.parametrize("filename", [
    "Movie.2010.DVD9.mkv",        # disc CAPACITY, not a part number
    "Movie.2010.DVD5.mkv",
    "Movie.2010.DVDRip.x264.mkv",
    "Dune.Part.Two.2024.mkv",     # spelled-out part is title text
    "Kill.Bill.Vol.1.2003.mkv",
])
def test_lookalike_tags_are_not_parts(filename):
    assert extract_part(filename) is None


# ── F5: subtitle language normalization ───────────────────────────────────
#
# Plex and Jellyfin index on the ISO-639-1 code. A library mixing ".en",
# ".eng" and untagged files shows the same track three times, twice unlabeled
# — and ".English" was dropped entirely, losing the language on rename.

@pytest.mark.parametrize("tag, expected", [
    (".eng", ".en"),
    (".English", ".en"),
    (".ENG", ".en"),
    (".ger", ".de"), (".deu", ".de"), (".German", ".de"),
    (".Portuguese", ".pt"), (".rum", ".ro"),
    (".en", ".en"),                       # already canonical
    (".forced.eng", ".en.forced"),        # flags move after the language
    (".eng.forced", ".en.forced"),
    (".hi.en", ".en.sdh"),                # "hi" is hearing-impaired here
    (".cc.eng", ".en.sdh"),
    (".forced.sdh.eng", ".en.forced.sdh"),
    ("", ""),
])
def test_tag_normalization(tag, expected):
    assert normalize_subtitle_tag(tag) == expected


@pytest.mark.parametrize("tag", [
    ".klingon",      # unknown word
    ".en-US",        # region subtag — valid, and not ours to rewrite
    ".forced",       # a flag with no language says nothing a rename improves
    ".hi",           # Hindi or hearing-impaired? refuse to guess
])
def test_unrecognised_tags_are_returned_untouched(tag):
    assert normalize_subtitle_tag(tag) == tag


@pytest.mark.parametrize("filename, raw", [
    ("Show.S01E01.eng.srt", ".eng"),
    ("Show.S01E01.English.srt", ".English"),
    ("Show.S01E01.forced.eng.srt", ".forced.eng"),
    ("Show.S01E01.srt", ""),
])
def test_tag_extraction(filename, raw):
    assert extract_subtitle_lang_tag(Path(filename)) == raw


@pytest.mark.parametrize("filename", [
    "Show.S01E01.Pilot.srt",       # the EPISODE TITLE, not a language
    "Show.S01E01.Deleted.srt",
    "Show.S01E01.Commentary.srt",
])
def test_a_trailing_word_is_not_assumed_to_be_a_language(filename):
    """The tag pattern admits full words only from the alias table. Accepting
    any 2-12 letter word would read "Pilot" as a language and move it out of
    the stem."""
    assert extract_subtitle_lang_tag(Path(filename)) == ""


def test_flags_survive_a_release_tag_before_them():
    """Regression: the tag group used to be repeated, and a repeated capture
    keeps only its LAST iteration — so a stem ending ".WEB-DL.forced.eng"
    captured just ".eng" and every renamed subtitle silently lost its forced
    flag."""
    assert extract_subtitle_lang_tag(
        Path("Show.S01E01.1080p.WEB-DL.forced.eng.srt")) == ".forced.eng"
    assert normalize_subtitle_tag(".forced.eng") == ".en.forced"


# ── F23: music album/artist from the folder layout ────────────────────────
#
# "Artist/Album (Year)/NN Title" is the layout every ripper writes, and for
# most libraries it is the ONLY place the album name exists. Reading only the
# stem sent MusicBrainz a title-only query and then wrote "Unknown Artist/
# Unknown Album/00 - Title" over information the app already had.

@pytest.mark.parametrize("path, expected", [
    ("/m/Radiohead/OK Computer (1997)/03 Subterranean Homesick Alien.flac",
     ("Radiohead", 3, "OK Computer", "Subterranean Homesick Alien", 1997)),
    ("/m/Nirvana/Nevermind [1991]/01. Smells Like Teen Spirit.mp3",
     ("Nirvana", 1, "Nevermind", "Smells Like Teen Spirit", 1991)),
    ("/m/Radiohead/OK Computer/03 - Airbag.flac",
     ("Radiohead", 3, "OK Computer", "Airbag", None)),
    ("/m/U2/The Joshua Tree/02 - One Tree Hill.flac",
     ("U2", 2, "The Joshua Tree", "One Tree Hill", None)),
    # the stem is more specific than the folders and still wins
    ("/m/Wrong/Folders/Artist - Album - 07 - Title.flac",
     ("Artist", 7, "Album", "Title", None)),
])
def test_music_folders_fill_what_the_stem_omits(path, expected):
    assert parse_music_info(Path(path)) == expected


@pytest.mark.parametrize("path", [
    "/m/Music/01 - Song.mp3",           # library root, not an album
    "/srv/music/Various Artists/01 - Song.mp3",
    "/m/downloads/flac/05 Track.flac",  # staging + format bucket
])
def test_library_roots_are_not_read_as_artists_or_albums(path):
    artist, _track, album, _title, _year = parse_music_info(Path(path))
    assert artist is None and album is None


def test_the_album_folder_year_beats_a_year_in_the_title():
    """"01 - 1979.flac" is a Smashing Pumpkins track, not a 1979 release."""
    result = detect(Path("/m/Smashing Pumpkins/Mellon Collie (1995)/01 - 1979.flac"))
    assert result.media_type is MediaType.MUSIC
    assert result.year == 1995
    assert result.album == "Mellon Collie"
    assert result.artist == "Smashing Pumpkins"
