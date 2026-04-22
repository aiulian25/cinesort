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
    original_filename: str = ""


# ---------- Video file extensions ----------
VIDEO_EXTENSIONS = {
    ".mkv", ".avi", ".mp4", ".m4v", ".mov", ".wmv", ".flv", ".webm",
    ".mpg", ".mpeg", ".ts", ".m2ts", ".vob", ".divx", ".ogm", ".rmvb",
}

SUBTITLE_EXTENSIONS = {".srt", ".sub", ".ass", ".ssa", ".idx", ".sup"}

AUDIO_EXTENSIONS = {
    ".mp3", ".flac", ".aac", ".ogg", ".opus", ".wma", ".wav",
    ".m4a", ".alac", ".ape", ".wv",
}

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
    re.compile(
        r'(?:EP|Episode)[.\s_-]*(\d{1,4})',
        re.IGNORECASE,
    ),
    # 8. Range without season: 02-05
    re.compile(
        r'(?<=[\s._-])(\d{2,3})\s*[-–]\s*(\d{2,3})(?=[\s._-])',
    ),
    # 9. Special episodes: SP01, SP 01
    re.compile(
        r'SP[.\s_-]*(\d{1,2})',
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

# ---------- Noise words to strip ----------
NOISE_PATTERNS = [
    VIDEO_SOURCE_PATTERN,
    VIDEO_FORMAT_PATTERN,
    VIDEO_CODEC_PATTERN,
    AUDIO_CODEC_PATTERN,
    VIDEO_TAGS_PATTERN,
    re.compile(r'\b(?:MULTI|DUAL|MULTi\.?SUBS?)\b', re.IGNORECASE),
    re.compile(r'\[[\w\-]+\]'),  # [tags]
    re.compile(r'\([\w\-]+\)'),  # (tags) at end
]


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

    # Cut at the season/episode marker
    for pattern in SXE_PATTERNS:
        m = pattern.search(name)
        if m:
            name = name[:m.start()]
            break
    else:
        # If no SxE found, cut at date
        dm = DATE_PATTERN.search(name)
        if dm:
            name = name[:dm.start()]

    # Cut at year for movies
    ym = YEAR_PATTERN.search(name)
    year_val = None
    if ym:
        year_val = int(ym.group(1))
        # Only cut if it looks like a movie (no episode info)
        if episode_info is None:
            name = name[:ym.start()]

    # Remove release group prefix [GroupName]
    name = re.sub(r'^\[([^\]]+)\]\s*', '', name)

    # Strip noise
    for p in NOISE_PATTERNS:
        name = p.sub('', name)

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
    m = YEAR_PATTERN.search(Path(filename).stem)
    if m:
        y = int(m.group(1))
        if 1920 <= y <= 2030:
            return y
    return None


def extract_video_format(filename: str) -> Optional[str]:
    m = VIDEO_FORMAT_PATTERN.search(filename)
    return m.group(0) if m else None


def extract_source(filename: str) -> Optional[str]:
    m = VIDEO_SOURCE_PATTERN.search(filename)
    return m.group(0) if m else None


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

    return MediaType.MOVIE


def detect(path: Path) -> DetectionResult:
    """Full detection pipeline for a media file."""
    filename = path.name
    media_type = classify_file(path)
    ep = parse_episode_info(filename)
    name = clean_name(filename, ep)

    # If name is too short, try parent folder
    if len(name) < 2 and path.parent.name:
        name = clean_name(path.parent.name, ep)

    return DetectionResult(
        media_type=media_type,
        clean_name=name,
        episode_info=ep,
        year=extract_year(filename),
        group=extract_release_group(filename),
        source=extract_source(filename),
        video_format=extract_video_format(filename),
        original_filename=filename,
    )
