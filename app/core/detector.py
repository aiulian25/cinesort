"""
Media file detector — ported from FileBot's SeasonEpisodeMatcher & AutoDetection.
Classifies files as Series/Movie/Music and extracts season/episode info.
"""

import re
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional
from enum import Enum


class MediaType(str, Enum):
    SERIES = "series"
    MOVIE = "movie"
    MUSIC = "music"
    UNKNOWN = "unknown"


@dataclass
class EpisodeInfo:
    season: Optional[int] = None
    episode: Optional[int] = None
    episode_end: Optional[int] = None  # for multi-episode files
    absolute: Optional[int] = None
    date: Optional[str] = None  # YYYY-MM-DD
    special: bool = False


@dataclass
class DetectionResult:
    media_type: MediaType
    clean_name: str
    episode_info: Optional[EpisodeInfo] = None
    year: Optional[int] = None
    group: Optional[str] = None
    source: Optional[str] = None
    video_format: Optional[str] = None
    # Template-token fields ({codec}/{audio}/{edition}) — extracted by the
    # same patterns that strip them from clean_name.
    codec: Optional[str] = None
    audio: Optional[str] = None
    edition: Optional[str] = None
    # Multi-part movies ({part}/{partN}); None for a single-file release.
    part: Optional[int] = None
    original_filename: str = ""
    # Music-only fields (parse_music_info); None for video/subtitle files.
    artist: Optional[str] = None
    album: Optional[str] = None
    track: Optional[int] = None
    title: Optional[str] = None


# ---------- Video file extensions ----------
VIDEO_EXTENSIONS = {
    ".mkv", ".avi", ".mp4", ".m4v", ".mov", ".wmv", ".flv", ".webm",
    ".mpg", ".mpeg", ".ts", ".m2ts", ".vob", ".divx", ".ogm", ".rmvb",
}

SUBTITLE_EXTENSIONS = {".srt", ".sub", ".ass", ".ssa", ".idx", ".sup", ".vtt"}

# ISO-639-2 codes and English language names → the ISO-639-1 code Plex and
# Jellyfin index on. A library mixing ".en", ".eng" and untagged files shows
# the same track three times, twice unlabeled.
SUBTITLE_LANG_ALIASES = {
    "eng": "en", "english": "en",
    "ger": "de", "deu": "de", "german": "de",
    "fre": "fr", "fra": "fr", "french": "fr",
    "spa": "es", "spanish": "es",
    "ita": "it", "italian": "it",
    "por": "pt", "portuguese": "pt",
    "rum": "ro", "ron": "ro", "romanian": "ro",
    "dut": "nl", "nld": "nl", "dutch": "nl",
    "swe": "sv", "swedish": "sv",
    "nor": "no", "norwegian": "no",
    "dan": "da", "danish": "da",
    "fin": "fi", "finnish": "fi",
    "pol": "pl", "polish": "pl",
    "rus": "ru", "russian": "ru",
    "jpn": "ja", "japanese": "ja",
    "kor": "ko", "korean": "ko",
    "chi": "zh", "zho": "zh", "chinese": "zh",
    "ara": "ar", "arabic": "ar",
    "tur": "tr", "turkish": "tr",
    "hun": "hu", "hungarian": "hu",
    "cze": "cs", "ces": "cs", "czech": "cs",
    "gre": "el", "ell": "el", "greek": "el",
    "heb": "he", "hebrew": "he",
    "hin": "hi", "hindi": "hi",
    "tha": "th", "thai": "th",
    "vie": "vi", "vietnamese": "vi",
    "ind": "id", "indonesian": "id",
    "ukr": "uk", "ukrainian": "uk",
}

# Track flags, normalized to what media servers read. "hi" (hearing impaired)
# collides with the ISO code for Hindi; it is read as a flag, which is what it
# means in nearly every subtitle release — see normalize_subtitle_tag.
SUBTITLE_FLAG_ALIASES = {"forced": "forced", "sdh": "sdh", "hi": "sdh", "cc": "sdh"}

_FLAG_ALTERNATION = "|".join(sorted(SUBTITLE_FLAG_ALIASES, key=len, reverse=True))
# Full language WORDS admitted into the tag, generated from the table above so
# the two can never drift apart. Deliberately NOT "any 2-12 letter word": that
# reads the episode title in "Show.S01E01.Pilot.srt" as a language.
_LANG_WORD_ALTERNATION = "|".join(
    sorted((k for k in SUBTITLE_LANG_ALIASES if len(k) > 3), key=len, reverse=True))

# Language tag patterns found between the episode stem and the subtitle extension
# e.g. Show.S01E01.en.srt, Show.S01E01.forced.en.srt, Show.S01E01.ro.hi.srt
#
# ONE flags-language-flags unit, deliberately not repeated: a repeated group
# keeps only its LAST iteration, so `Show.S01E01.WEB-DL.forced.eng` matched
# `.WEB-DL.forced.eng` but captured just `.eng` — silently dropping the
# forced flag from every renamed subtitle whose stem ended that way.
_LANG_TAG_RE = re.compile(
    r'(?P<lang>(?:\.(?:' + _FLAG_ALTERNATION + r'))*'
    r'(?:\.(?:' + _LANG_WORD_ALTERNATION + r')|\.[a-z]{2,3}(?:-[A-Za-z]{2,4})?)'
    r'(?:\.(?:' + _FLAG_ALTERNATION + r'))*)$',
    re.IGNORECASE,
)


def extract_subtitle_lang_tag(path: Path) -> str:
    """Return the language/flag suffix found before the extension, or empty string.
    E.g. 'Show.S01E01.en.srt' → '.en'
         'Show.S01E01.forced.en.srt' → '.forced.en'
         'Show.S01E01.mkv' → ''
    """
    stem = path.stem  # everything before the last dot
    m = _LANG_TAG_RE.search(stem)
    return m.group("lang") if m else ""

def normalize_subtitle_tag(tag: str) -> str:
    """Canonical form of a language suffix: ISO-639-1 code, then flags.

        '.eng' → '.en'        '.English' → '.en'
        '.forced.eng' → '.en.forced'      '.hi.en' → '.en.sdh'

    Flags are matched BEFORE languages, which decides the one genuine
    ambiguity: "hi" is both the ISO code for Hindi and the usual abbreviation
    for hearing-impaired. In a tag it is read as the flag — ".hi.en" is an
    English SDH track, not a Hindi one — and a lone ".hi" is left untouched
    rather than guessed at.

    Anything not recognised (a region subtag, an unknown word) returns the tag
    EXACTLY as it arrived. Renaming is destructive; guessing a language is not
    a risk worth taking to save a user one edit.
    """
    if not tag:
        return ""

    lang = None
    flags = []
    for token in (t for t in tag.split(".") if t):
        lowered = token.lower()
        if lowered in SUBTITLE_FLAG_ALIASES:
            flags.append(SUBTITLE_FLAG_ALIASES[lowered])
            continue
        if lang is None:
            if lowered in SUBTITLE_LANG_ALIASES:
                lang = SUBTITLE_LANG_ALIASES[lowered]
                continue
            if re.fullmatch(r"[a-z]{2}", lowered):
                lang = lowered
                continue
        return tag   # unknown token, or a second language — never guess

    if lang is None:
        return tag   # flags with no language say nothing a rename can improve

    suffix = "." + ".".join(sorted(set(flags))) if flags else ""
    return f".{lang}{suffix}"


AUDIO_EXTENSIONS = {
    ".mp3", ".flac", ".aac", ".ogg", ".opus", ".wma", ".wav",
    ".m4a", ".alac", ".ape", ".wv",
}

# ---------- Release samples and media-server extras ----------
# A scene sample is the same title at 30-60 seconds, so it matches the SAME
# record as the feature and lands on the same destination — a duplicate
# conflict at best, and an overwrite of the real file when the feature is not
# in the batch.
#
# Anchored at the END of the stem on purpose: "Sample This" (2015) and
# "Free Samples" (2012) are real films, and a substring test would refuse to
# rename them forever.
SAMPLE_STEM_RE = re.compile(r'(?:^|[\s._-])sample$', re.IGNORECASE)

# Plex/Jellyfin/Kodi local-extras folder names, plus the sample folders release
# groups ship. Compared case-insensitively against directory names.
EXTRAS_FOLDERS = frozenset({
    "extras", "featurettes", "behind the scenes", "deleted scenes",
    "trailers", "interviews", "scenes", "shorts", "other",
    "sample", "samples",
})


def is_sample_or_extra(path: Path, root: Optional[Path] = None) -> bool:
    """True for a release sample or a media-server extras file.

    `root` is the folder the user asked to scan. Only directories BELOW it are
    considered: someone who points the scanner straight at
    /media/Movie (2010)/Featurettes wants those files, and the exclusion must
    not swallow the very folder they named. Without a root the check falls back
    to the two directories above the file, which is the depth every documented
    extras layout uses.
    """
    if SAMPLE_STEM_RE.search(path.stem):
        return True

    if root is not None:
        try:
            folders = path.relative_to(root).parent.parts
        except ValueError:
            folders = ()
    else:
        folders = (path.parent.name, path.parent.parent.name)

    return any(name.lower() in EXTRAS_FOLDERS for name in folders)

# ---------- Season/Episode regex patterns (ported from FileBot's 16 patterns) ----------
# Priority order matters — first match wins

SXE_PATTERNS = [
    # 1. Verbose: "Season 1 Episode 2"
    re.compile(
        r'(?:Season|Series)[.\s_-]*(\d{1,4})[.\s_-]*'
        r'(?:Episode|Ep\.?)[.\s_-]*(\d{1,3})(?:[.\s_-]*(?:Episode|Ep\.?|E|-)[.\s_-]*(\d{1,3}))?',
        re.IGNORECASE,
    ),
    # 2. Range: S01E02-E05 or S01E02-05
    re.compile(
        r'S(\d{1,4})[.\s_-]*E(\d{2,3})[.\s_-]*[-–]\s*E?(\d{2,4})',
        re.IGNORECASE,
    ),
    # 3. Standard: S01E02
    re.compile(
        r'S(\d{1,4})[.\s_-]*E(\d{1,3})',
        re.IGNORECASE,
    ),
    # 4. X notation range: 1x02-05 or 1x02-1x05
    re.compile(
        r'(?<!\d)(\d{1,2})x(\d{2,3})\s*[-–]\s*(?:\d{1,2}x)?(\d{2,3})(?!\d)',
        re.IGNORECASE,
    ),
    # 5. Numbered: 1x02, 01x02
    re.compile(
        r'(?<!\d)(\d{1,2})x(\d{2,3})(?!\d)',
        re.IGNORECASE,
    ),
    # 6. Dot notation: 1.02 (only in context)
    re.compile(
        r'(?<=[\s._-])(\d{1,2})\.(\d{2})(?=[\s._-])',
    ),
    # 7. Episode only: EP02, Episode 02
    # The left boundary is load-bearing: without it "ep" matches INSIDE a word,
    # so Deep4K, Step4, sleep12 and the 2023 film Sleep.2023 all parsed as
    # "Episode N". classify_file() reads the parent folder too, so one folder
    # named "Deep4K" turned every film inside it into a series.
    re.compile(
        r'(?<![A-Za-z])(?:EP|Episode)[.\s_-]*(\d{1,4})',
        re.IGNORECASE,
    ),
    # 8. Range without season: 02-05
    re.compile(
        r'(?<=[\s._-])(\d{2,3})\s*[-–]\s*(\d{2,3})(?=[\s._-])',
    ),
    # 9. Special episodes: SP01, SP 01
    # Same word-interior trap as pattern 7: Gasp.2019, Crisp.2 and Grasp.1
    # matched "sp" mid-word and became specials.
    re.compile(
        r'(?<![A-Za-z])SP[.\s_-]*(\d{1,2})',
        re.IGNORECASE,
    ),
    # 10. Multi-episode consecutive: E01E02 or E01E02E03
    re.compile(
        r'E(\d{2,3})(?:\s*E(\d{2,3}))+',
        re.IGNORECASE,
    ),
    # 11. " - 42" absolute numbering (common in anime)
    re.compile(
        r'(?<=\s-\s)(\d{1,4})(?:\s*v\d)?(?=[\s._\[\(-]|$)',
    ),
    # 12. Compact 3-digit: show.102 = season 1, episode 02
    re.compile(
        r'(?<=[\s._-])(\d)(\d{2})(?=[\s._-]|$)',
    ),
]

# ---------- Date pattern ----------
DATE_PATTERN = re.compile(
    r'(\d{4})[.\s_-](\d{2})[.\s_-](\d{2})'
)

# ---------- Library-layout folders ----------
# Plex/Jellyfin/Sonarr lay libraries out as "Show Name (Year)/Season NN/file",
# which leaves the filename free to carry nothing but an episode number. The
# title then lives in the folder tree and nowhere else.
SEASON_FOLDER_RE = re.compile(
    r'^(?:Season|Series|Staffel|Saison|Temporada|Stagione|Sezon)[\s._-]*(\d{1,3})$'
    r'|^S(\d{1,3})$'
    r'|^Specials?$',
    re.IGNORECASE,
)

DISC_FOLDER_RE = re.compile(r'^(?:Disc|Disk|CD|DVD|BD)[\s._-]*\d{1,2}$', re.IGNORECASE)

# Library roots and staging folders. Reaching one means the walk left the show's
# own folder without finding a title — "Downloads" is not a series name, and
# adopting it is how every file in a staging folder ends up in one bogus group.
GENERIC_FOLDERS = frozenset({
    "tv", "tv shows", "tvshows", "shows", "series", "anime",
    "movies", "movie", "films", "film", "media", "video", "videos",
    "downloads", "download", "incoming", "complete", "completed",
    "library", "plex", "jellyfin", "kodi", "emby", "torrents", "usenet",
    "home", "mnt", "srv", "data", "volume1", "public", "share", "shared",
})

# A stem that is only an episode number. Meaningless on its own — "300" is a
# film — so it is read as an episode ONLY when a season folder says so.
BARE_EPISODE_RE = re.compile(r'^E?(\d{1,3})$', re.IGNORECASE)

# How far above the file to look for the show folder. Three covers the deepest
# documented layout, "Show/Season 1/Disc 1/file"; the same bound
# _prune_empty_dirs uses when walking the other way.
MAX_FOLDER_WALK = 3

SPECIALS_SEASON = 0


def season_from_folder(name: str) -> Optional[int]:
    """Season number a folder name declares, or None if it declares none.
    'Specials' is season 0, the number every media server files it under."""
    match = SEASON_FOLDER_RE.match(name.strip())
    if not match:
        return None
    number = match.group(1) or match.group(2)
    return int(number) if number else SPECIALS_SEASON


def infer_from_folders(path: Path) -> tuple[Optional[str], Optional[int], Optional[int]]:
    """(show name, year, season) read from the folders above `path`.

    Walks up at most MAX_FOLDER_WALK levels: disc folders are stepped over,
    season folders contribute the season number and are stepped over, and the
    first ordinary folder is the show. Hitting a generic library root stops the
    walk with no name — better to report nothing than to name a series after
    the folder every unrelated download also sits in.
    """
    season: Optional[int] = None

    for folder in list(path.parents)[:MAX_FOLDER_WALK]:
        name = folder.name
        if not name:
            break
        if DISC_FOLDER_RE.match(name):
            continue
        folder_season = season_from_folder(name)
        if folder_season is not None:
            if season is None:
                season = folder_season
            continue
        if name.lower() in GENERIC_FOLDERS:
            break
        return clean_name(name), extract_year(name), season

    return None, None, season


# ---------- Release info patterns (from FileBot's ReleaseInfo.properties) ----------
VIDEO_SOURCE_PATTERN = re.compile(
    r'\b(?:BluRay|Blu-Ray|BDRip|BRRip|HDRip|DVDRip|DVDScr|DVDR|WEB[-.]?DL|'
    r'WEB[-.]?Rip|WEBRip|WEB|HDTV|PDTV|SDTV|DSR|TVRip|SATRip|CAMRip|TS|TC|'
    r'TELECINE|TELESYNC|R5|SCR|PPV|VOD|AMZN|NF|DSNP|HMAX|ATVP|PCOK|PMTP)\b',
    re.IGNORECASE,
)

VIDEO_FORMAT_PATTERN = re.compile(
    r'\b(?:480[pi]|576[pi]|720[pi]|1080[pi]|2160[pi]|4320[pi]|4K|UHD|'
    r'(?:7680|3840|1920|1280|720|640)x\d{3,4})\b',
    re.IGNORECASE,
)

VIDEO_CODEC_PATTERN = re.compile(
    r'\b(?:x264|x265|h\.?264|h\.?265|HEVC|AVC|XviD|DivX|VP9|AV1|'
    r'MPEG[24]?|10bit|8bit|Hi10P|HDR(?:10)?|DV|DoVi|Dolby\.?Vision)\b',
    re.IGNORECASE,
)

AUDIO_CODEC_PATTERN = re.compile(
    r'\b(?:AAC|AC3|DTS(?:[.\s-]?(?:HD|MA|X|ES))?|TrueHD|Atmos|'
    r'FLAC|MP3|EAC3|DD[P+]?(?:5\.1|7\.1)?|LPCM|PCM|Opus)\b',
    re.IGNORECASE,
)

RELEASE_GROUP_PATTERN = re.compile(
    r'(?:^[\[\(]([^\]\)]+)[\]\)]|[-]([A-Za-z0-9]+)$)'
)

YEAR_PATTERN = re.compile(
    r'(?:[\s._(\[-])?((?:19|20)\d{2})(?:[\s._)\]-]|$)'
)

VIDEO_TAGS_PATTERN = re.compile(
    r'\b(?:(?:Special|Extended|Ultimate|Director.?s|Collector.?s|Theatrical|Final|'
    r'Rogue|Diamond|Despecialized|Remastered|Anniversary)'
    r'[.\s_-]*(?:Cut|Edition|Version)?|Extended|Theatrical|Remastered|Recut|'
    r'Uncut|Uncensored|Unrated|IMAX|Alternate[.\s_-]*Ending|REPACK|PROPER|RERIP)\b',
    re.IGNORECASE,
)

# ---------- Multi-part movies ----------
# A film split across two files: Movie.2010.CD1.mkv / .CD2.mkv. Without a
# {part} token both parts render the SAME destination and collide, and the only
# escape the UI offers is "Movie (2010) (2).mkv" — a name no media server
# stacks back into one film.
#
# "DVD" is deliberately NOT a keyword: DVD5 and DVD9 are disc-capacity tags,
# not part numbers, and they are far more common in release names than DVD1.
PART_PATTERN = re.compile(
    r'(?<![A-Za-z0-9])(?P<kind>CD|Disc|Disk|Part|pt)[\s._-]*(?P<number>\d{1,2})(?![A-Za-z0-9])',
    re.IGNORECASE,
)

# The keywords above that are never part of a real film title. "Part" is
# missing on purpose — "Harry Potter and the Deathly Hallows Part 1" is the
# title TMDb knows, and stripping it would hand the search a worse query.
PART_NOISE_PATTERN = re.compile(
    r'(?<![A-Za-z0-9])(?:CD|Disc|Disk|pt)[\s._-]*\d{1,2}(?![A-Za-z0-9])',
    re.IGNORECASE,
)

# ---------- Noise words to strip ----------
NOISE_PATTERNS = [
    PART_NOISE_PATTERN,
    VIDEO_SOURCE_PATTERN,
    VIDEO_FORMAT_PATTERN,
    VIDEO_CODEC_PATTERN,
    AUDIO_CODEC_PATTERN,
    VIDEO_TAGS_PATTERN,
    re.compile(r'\b(?:MULTI|DUAL|MULTi\.?SUBS?)\b', re.IGNORECASE),
    # Release tokens that are never title words — safe case-insensitively.
    re.compile(r'\b(?:Hybrid|REMUX|HDR10(?:Plus|\+)?)\b', re.IGNORECASE),
    # Language / dub tags. CASE-SENSITIVE on purpose: scene grammar writes
    # these in caps or the stylized lowercase-i form (GERMAN.DL, iTALiAN,
    # SPANiSH), while real titles use ordinary capitalization — and matching
    # case-insensitively would strip the word out of "The Italian Job", "The
    # French Connection", "The Danish Girl" and "French Kiss", turning a
    # mismatch bug into a far worse one. Both spellings are listed so the
    # scene forms still match.
    re.compile(r'\b(?:GERMAN|FRENCH|TRUEFRENCH|ITALIAN|iTALiAN|SPANISH|SPANiSH|'
               r'NORDIC|NORDiC|SWEDISH|SWEDiSH|DANISH|DANiSH|FINNISH|FiNNiSH|'
               r'DUBBED|SUBBED|VFF|VFQ|VOSTFR|DL)\b'),
    re.compile(r'\[[\w\-]+\]'),  # [tags]
    re.compile(r'\([\w\-]+\)'),  # (tags) at end
]


# A four-digit number in a filename is not automatically a release year:
# YEAR_PATTERN matches any (19|20)\d{2}, which also hits the NUMBER IN A TITLE
# — "Blade Runner 2049", "2046", "2012", "1917". Bounding the value and
# preferring a match that still leaves a title behind is what tells the two
# apart, and both the year extractor and the title cleaner must agree on which
# match they picked, or the title keeps a year the search filter does not use.
YEAR_MIN, YEAR_MAX = 1920, 2030


def _release_year_match(name: str):
    """The match to treat as the release year, or None.

    First choice: a plausible year whose cut still leaves a title behind
    ("2012.2009" → 2009, keeping "2012"). Falls back to the first plausible
    match when every candidate would empty the name.
    """
    fallback = None
    for m in YEAR_PATTERN.finditer(name):
        if not (YEAR_MIN <= int(m.group(1)) <= YEAR_MAX):
            continue          # 2049 / 2046 — a title number, not a year
        if fallback is None:
            fallback = m
        if name[:m.start()].strip(" ._-"):
            return m
    return fallback


# A trailing "-GROUP" is only a release group when the filename is actually a
# scene release. Guard, not a bare regex: `-[A-Za-z0-9]{2,15}$` on its own
# rewrites "Spider-Man" to "Spider", "Ant-Man" to "Ant" and "X-Men" to "X".
_TRAILING_GROUP_RE = re.compile(r'-[A-Z0-9]{2,15}$')


def _looks_like_release(stem: str) -> bool:
    """True when the filename carries source/format/codec/audio tags — i.e.
    scene grammar, where a trailing token is a group rather than title text."""
    return any(p.search(stem) for p in (
        VIDEO_SOURCE_PATTERN, VIDEO_FORMAT_PATTERN,
        VIDEO_CODEC_PATTERN, AUDIO_CODEC_PATTERN,
    ))


def is_video_file(path: Path) -> bool:
    return path.suffix.lower() in VIDEO_EXTENSIONS


def is_subtitle_file(path: Path) -> bool:
    return path.suffix.lower() in SUBTITLE_EXTENSIONS


def is_audio_file(path: Path) -> bool:
    return path.suffix.lower() in AUDIO_EXTENSIONS


def parse_episode_info(name: str) -> Optional[EpisodeInfo]:
    """Extract season/episode information from a filename string.
    Uses FileBot-style cascading pattern matching."""

    # Try date-based episodes first (e.g., daily shows)
    dm = DATE_PATTERN.search(name)

    for i, pattern in enumerate(SXE_PATTERNS):
        m = pattern.search(name)
        if not m:
            continue

        # A full date (YYYY.MM.DD / YYYY-MM-DD) must win over pseudo-SxE
        # fragments inside it: dot-notation would read "03.05" out of
        # "2024.03.05" as S03E05, and the range pattern would read "03-05"
        # out of "2024-03-05" as episodes 3–5 — so a daily-show file never
        # reached the date fallback below.
        if dm and m.start() >= dm.start() and m.end() <= dm.end():
            continue

        groups = m.groups()

        # Pattern 0: Verbose Season X Episode Y[-Z]
        if i == 0:
            ep_end = int(groups[2]) if groups[2] else None
            return EpisodeInfo(season=int(groups[0]), episode=int(groups[1]), episode_end=ep_end)

        # Pattern 1: Range S01E02-E05
        if i == 1:
            return EpisodeInfo(season=int(groups[0]), episode=int(groups[1]), episode_end=int(groups[2]))

        # Pattern 2: S01E02
        if i == 2:
            return EpisodeInfo(season=int(groups[0]), episode=int(groups[1]))

        # Pattern 3: X notation range 1x02-05
        if i == 3:
            return EpisodeInfo(season=int(groups[0]), episode=int(groups[1]), episode_end=int(groups[2]))

        # Pattern 4: 1x02
        if i == 4:
            return EpisodeInfo(season=int(groups[0]), episode=int(groups[1]))

        # Pattern 5: Dot notation 1.02
        if i == 5:
            return EpisodeInfo(season=int(groups[0]), episode=int(groups[1]))

        # Pattern 6: EP02 (no season)
        if i == 6:
            return EpisodeInfo(episode=int(groups[0]))

        # Pattern 7: Range 02-05 (no season)
        if i == 7:
            return EpisodeInfo(episode=int(groups[0]), episode_end=int(groups[1]))

        # Pattern 8: SP01 (special)
        if i == 8:
            return EpisodeInfo(season=0, episode=int(groups[0]), special=True)

        # Pattern 9: Multi-episode E01E02E03
        if i == 9:
            # Extract all episode numbers from the match
            all_eps = re.findall(r'E(\d{2,3})', m.group(0), re.IGNORECASE)
            if len(all_eps) >= 2:
                eps = [int(e) for e in all_eps]
                return EpisodeInfo(episode=eps[0], episode_end=eps[-1])

        # Pattern 10: Absolute numbering " - 42"
        if i == 10:
            return EpisodeInfo(absolute=int(groups[0]))

        # Pattern 11: Compact 3-digit 102 = S1E02
        if i == 11:
            s, e = int(groups[0]), int(groups[1])
            if 1 <= s <= 30 and 1 <= e <= 50:
                return EpisodeInfo(season=s, episode=e)

    # Fallback: date-based
    if dm:
        return EpisodeInfo(date=f"{dm.group(1)}-{dm.group(2)}-{dm.group(3)}")

    return None


def clean_name(name: str, episode_info: Optional[EpisodeInfo] = None) -> str:
    """Clean a media filename to extract the likely series/movie name.
    Ported from FileBot's ReleaseInfo.cleanRelease()."""

    # Remove file extension
    name = Path(name).stem
    stem0 = name          # pre-cut copy — used to recognize scene grammar below

    # Cut at the season/episode marker — but ignore pseudo-SxE fragments that
    # sit inside a full date (see parse_episode_info); those files cut at the
    # date instead, so "The.Daily.Show.2024.03.05" cleans to "The Daily Show".
    dm = DATE_PATTERN.search(name)
    cut = None
    for pattern in SXE_PATTERNS:
        m = pattern.search(name)
        if not m:
            continue
        if dm and m.start() >= dm.start() and m.end() <= dm.end():
            continue
        cut = m.start()
        break
    if cut is None and dm:
        cut = dm.start()
    if cut is not None:
        name = name[:cut]
    cut_applied = cut is not None

    # Cut at year for movies
    ym = _release_year_match(name)
    year_val = None
    if ym:
        year_val = int(ym.group(1))
        # Only cut if it looks like a movie (no episode info)
        if episode_info is None:
            name = name[:ym.start()]
            cut_applied = True
        else:
            # Series: the SxE cut above already removed everything after the
            # episode marker, so a year left at the END is the release-year
            # token that sat between title and SxE ("Lucky.2026.S01E01" →
            # "Lucky.2026."). Keeping it sends "Lucky 2026" to the provider,
            # which fuzzy-matches a DIFFERENT show ("Lucky Luke") and — being
            # a single result — skips the disambiguation prompt entirely. The
            # year is extracted separately and passed as the search filter, so
            # dropping it from the query loses nothing.
            tail = re.search(r'[\s._(\[-]*((?:19|20)\d{2})[\s._)\]-]*$', name)
            if tail and YEAR_MIN <= int(tail.group(1)) <= YEAR_MAX:
                trimmed = name[:tail.start()]
                # A show titled AS a year ("1923", "1883") would be erased —
                # keep the original when nothing meaningful survives.
                if trimmed.strip(' ._-'):
                    name = trimmed

    # Remove release group prefix [GroupName]
    name = re.sub(r'^\[([^\]]+)\]\s*', '', name)

    # Strip noise
    for p in NOISE_PATTERNS:
        name = p.sub('', name)

    # A release group survives only when nothing cut the name short — a year
    # or SxE cut already removed everything after the title. Three conditions,
    # each closing a way the strip would eat real titles:
    #   * no cut happened   — else "Mad-Max.2015…-GRP" cuts to "Mad-Max" and
    #                         the tail "-Max" is title text, not a group;
    #   * scene grammar     — "Spider-Man.mkv" has no release tags, so its
    #                         "-Man" must be left alone;
    #   * ALL-CAPS tail     — groups are written SPARKS/RARBG/AOC, while title
    #                         words are capitalized ("Man", "Men", "Max").
    # A mixed-case group (Tigole, Vyndros) is deliberately left in place: the
    # trimmed-query cascade in main.py drops trailing tokens anyway, so a
    # residual token is recoverable — a truncated title is not.
    if not cut_applied and _looks_like_release(stem0):
        name = _TRAILING_GROUP_RE.sub('', name.strip())

    # Normalize separators: dots, underscores → spaces
    name = re.sub(r'[._]', ' ', name)
    # Collapse multiple separators
    name = re.sub(r'[-–—]+', ' ', name)
    # Collapse whitespace
    name = re.sub(r'\s+', ' ', name)
    name = name.strip(' -–')

    return name


def extract_release_group(filename: str) -> Optional[str]:
    stem = Path(filename).stem
    # Try trailing -GROUP
    m = re.search(r'-([A-Za-z0-9]{2,15})$', stem)
    if m:
        group = m.group(1)
        # Filter out common false positives
        if group.upper() not in {"MKV", "AVI", "MP4", "SRT", "HEVC", "X264", "X265", "AAC", "AC3"}:
            return group
    # Try leading [GROUP]
    m = re.match(r'^\[([^\]]+)\]', stem)
    if m:
        return m.group(1)
    return None


def extract_year(filename: str) -> Optional[int]:
    """Release year, agreeing with the one clean_name cut on (see
    _release_year_match) — otherwise the title would keep a year the provider
    search does not filter by."""
    m = _release_year_match(Path(filename).stem)
    return int(m.group(1)) if m else None


def extract_video_format(filename: str) -> Optional[str]:
    m = VIDEO_FORMAT_PATTERN.search(filename)
    return m.group(0) if m else None


def extract_source(filename: str) -> Optional[str]:
    m = VIDEO_SOURCE_PATTERN.search(filename)
    return m.group(0) if m else None


def extract_codec(filename: str) -> Optional[str]:
    m = VIDEO_CODEC_PATTERN.search(filename)
    return m.group(0) if m else None


def extract_audio(filename: str) -> Optional[str]:
    m = AUDIO_CODEC_PATTERN.search(filename)
    return m.group(0) if m else None


# Release-quality flags matched by VIDEO_TAGS_PATTERN that are NOT editions —
# "Movie (2010) [REPACK]" is not a Jellyfin/Plex edition name.
_NON_EDITION_TAGS = {"repack", "proper", "rerip"}


def extract_part(filename: str) -> Optional[int]:
    """Part number of a split release, or None.

    CD/Disc/Disk/pt are accepted anywhere: they are never title words. "Part"
    is accepted ONLY after the release year, because before it the word almost
    always belongs to the title — "Harry.Potter.Deathly.Hallows.Part.1.2010"
    is one film named Part 1, while "Movie.2010.Part1" is half of one. With no
    year to separate them the conservative reading wins and the title keeps the
    word.
    """
    stem = Path(filename).stem
    year_match = _release_year_match(stem)

    for match in PART_PATTERN.finditer(stem):
        if match.group("kind").lower() == "part":
            if year_match is None or match.start() < year_match.end():
                continue
        return int(match.group("number"))
    return None


def extract_edition(filename: str) -> Optional[str]:
    """Edition tag for the {edition} token: 'Extended', "Director's",
    'Remastered', 'IMAX'… Normalized: separators to spaces, the trailing
    Cut/Edition/Version word stripped ('Extended.Cut' and 'Extended Edition'
    both yield 'Extended'), words title-cased except short all-caps acronyms
    (IMAX) — plain .title() would mangle "Director's" into "Director'S"."""
    for m in VIDEO_TAGS_PATTERN.finditer(filename):
        tag = re.sub(r'[._-]+', ' ', m.group(0)).strip()
        tag = re.sub(r'\s*(?:Cut|Edition|Version)$', '', tag, flags=re.IGNORECASE).strip()
        if not tag or tag.lower() in _NON_EDITION_TAGS:
            continue
        return " ".join(
            w if (w.isupper() and len(w) <= 4) else (w[0].upper() + w[1:].lower())
            for w in tag.split()
        )
    return None


# "OK Computer (1997)" / "Kid A [2000]" — the year a music folder carries.
ALBUM_FOLDER_RE = re.compile(r'^(?P<album>.+?)\s*[\(\[](?P<year>(?:19|20)\d{2})[\)\]]$')

# Folder names that are a library root or a format bucket, never an artist or
# an album. GENERIC_FOLDERS already lists the library roots (see F1); these are
# the audio-specific ones.
MUSIC_JUNK_FOLDERS = GENERIC_FOLDERS | frozenset({
    "music", "musik", "musique", "audio", "songs", "tracks",
    "flac", "mp3", "aac", "ogg", "opus", "wav", "alac", "m4a",
    "albums", "singles", "various artists", "va", "compilations", "soundtracks",
})

# "U2" and "AJR" are artists; a one-character folder is a mount point.
MIN_MUSIC_FOLDER_NAME = 2

# "01 Title", "01. Title", "01 - Title" — a track number with no " - " grammar
# around it, which the part-splitting below cannot see.
BARE_TRACK_RE = re.compile(r'^(?P<track>\d{1,3})[.\s_-]+(?P<title>.+)$')


def _music_folder_name(name: str) -> Optional[str]:
    """A folder name usable as an artist or album, or None."""
    cleaned = name.strip()
    if len(cleaned) < MIN_MUSIC_FOLDER_NAME or cleaned.lower() in MUSIC_JUNK_FOLDERS:
        return None
    return cleaned


def parse_music_info(
    path: Path,
) -> tuple[Optional[str], Optional[int], Optional[str], Optional[str], Optional[int]]:
    """Parse an audio file into (artist, track, album, title, year).

    Handles the common stem layouts, most-specific first:
      Artist - Album - NN - Title
      NN - Artist - Title
      Artist - NN - Title
      NN - Title
      NN Title            (no " - " grammar at all)
      Artist - Title
      Title
    Separators: " - " primarily; underscores are normalized to spaces first.

    What the stem does not say, the FOLDERS do: `Artist/Album (Year)/track` is
    the layout every ripper writes, and it is the only place the album name
    exists for most libraries. Reading it is the difference between
    "Radiohead/OK Computer/03 - …" and "Unknown Artist/Unknown Album/00 - …".
    """
    s = re.sub(r'[_]+', ' ', path.stem).strip()
    parts = [p.strip() for p in s.split(" - ") if p.strip()]

    def is_track(p: str) -> bool:
        return bool(re.fullmatch(r'\d{1,3}', p)) and len(p) <= 3

    artist = album = title = None
    track: Optional[int] = None
    year: Optional[int] = None

    if len(parts) >= 4 and is_track(parts[2]):
        artist, album, track, title = parts[0], parts[1], int(parts[2]), " - ".join(parts[3:])
    elif len(parts) == 3 and is_track(parts[0]):
        track, artist, title = int(parts[0]), parts[1], parts[2]
    elif len(parts) == 3 and is_track(parts[1]):
        artist, track, title = parts[0], int(parts[1]), parts[2]
    elif len(parts) == 2 and is_track(parts[0]):
        track, title = int(parts[0]), parts[1]
    elif len(parts) == 2:
        artist, title = parts[0], parts[1]
    elif parts:
        title = parts[0]

    # "01 Title" with no " - " anywhere: the split above saw a single part.
    if track is None and title:
        bare = BARE_TRACK_RE.match(title)
        if bare:
            track = int(bare.group("track"))
            title = bare.group("title").strip()

    # Folders fill only what the stem left empty — a stem that names the album
    # is more specific than the directory it happens to sit in.
    folder = _music_folder_name(path.parent.name)
    if album is None and folder:
        match = ALBUM_FOLDER_RE.match(folder)
        if match:
            album = match.group("album").strip()
            year = int(match.group("year"))
        else:
            album = folder
    if artist is None:
        grandparent = _music_folder_name(path.parent.parent.name)
        if grandparent:
            artist = grandparent

    return artist, track, album, title, year


def classify_file(path: Path) -> MediaType:
    """Classify a file as series, movie, music, or unknown.
    Ported from FileBot's AutoDetection logic."""

    if is_audio_file(path):
        return MediaType.MUSIC

    if not is_video_file(path) and not is_subtitle_file(path):
        return MediaType.UNKNOWN

    name = path.stem
    ep = parse_episode_info(name)

    if ep and (ep.season is not None or ep.episode is not None or ep.absolute is not None):
        return MediaType.SERIES

    if ep and ep.date:
        return MediaType.SERIES

    # Heuristic: if parent folder looks like a series
    parent = path.parent.name
    parent_ep = parse_episode_info(parent)
    if parent_ep:
        return MediaType.SERIES

    # A season folder anywhere in the layout above the file is an explicit
    # declaration, not a heuristic: the filename inside it may be nothing but
    # "E01.mkv", which parses to nothing and used to make every episode of the
    # season a separate "movie". The same walk detect() uses, so a "Disc 1"
    # level between the file and its season folder is stepped over here too.
    if infer_from_folders(path)[2] is not None:
        return MediaType.SERIES

    return MediaType.MOVIE


def detect(path: Path) -> DetectionResult:
    """Full detection pipeline for a media file."""
    filename = path.name
    media_type = classify_file(path)

    # Audio files get music parsing — the video pipeline's SxE/noise stripping
    # would mangle "Artist - Title" stems.
    if media_type == MediaType.MUSIC:
        artist, track, album, title, folder_year = parse_music_info(path)
        clean = " - ".join(x for x in (artist, title) if x) or Path(filename).stem
        return DetectionResult(
            media_type=media_type,
            clean_name=clean,
            episode_info=None,
            # The album folder's year beats a year scraped out of the filename:
            # "01 - 1979.flac" is a Smashing Pumpkins track, not a 1979 release.
            year=folder_year or extract_year(filename),
            original_filename=filename,
            artist=artist,
            album=album,
            track=track,
            title=title,
        )

    ep = parse_episode_info(filename)
    name = clean_name(filename, ep)
    year = extract_year(filename)

    if media_type == MediaType.SERIES:
        folder_name, folder_year, folder_season = infer_from_folders(path)

        # The stem carries an episode marker and nothing else — "S01E01",
        # "E01", "01" — so what survives cleaning is either empty or the
        # season folder's own name. The title is in the tree.
        title_is_absent = (
            len(name) < 2
            or season_from_folder(name) is not None
            or BARE_EPISODE_RE.match(name) is not None
        )
        if folder_name and title_is_absent:
            name = folder_name
            # The year is only borrowed from a folder we already trusted for
            # the title, so a film sitting in "Movies 2023" keeps its own.
            if year is None:
                year = folder_year

        if ep is None and folder_season is not None:
            # "E01"/"01" is an episode number ONLY because a season folder
            # says so — read out of context it is a film called 300.
            bare = BARE_EPISODE_RE.match(Path(filename).stem)
            if bare:
                ep = EpisodeInfo(season=folder_season, episode=int(bare.group(1)))
        elif ep is not None and ep.season is None and folder_season is not None:
            ep.season = folder_season

    # If name is too short, try parent folder
    if len(name) < 2 and path.parent.name:
        name = clean_name(path.parent.name, ep)

    return DetectionResult(
        media_type=media_type,
        clean_name=name,
        episode_info=ep,
        year=year,
        group=extract_release_group(filename),
        source=extract_source(filename),
        video_format=extract_video_format(filename),
        codec=extract_codec(filename),
        audio=extract_audio(filename),
        edition=extract_edition(filename),
        part=extract_part(filename),
        original_filename=filename,
    )
