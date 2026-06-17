"""
Similarity matching engine — ported from FileBot's Matcher.deepMatch()
and EpisodeMetrics cascade. Matches detected files against API metadata.
"""

import re
import unicodedata
from difflib import SequenceMatcher
from typing import Optional


def normalize(text: str) -> str:
    """Normalize text for comparison — ported from FileBot's Normalization.java.
    Strips accents, lowercases, collapses whitespace."""
    # Decompose unicode, strip combining marks (accents)
    text = unicodedata.normalize("NFD", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = text.lower()
    # Normalize separators
    text = re.sub(r'[._\-–—:;!?,\'\"()[\]{}]', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


def tokenize(text: str) -> list[str]:
    """Split normalized text into word tokens."""
    return normalize(text).split()


def name_similarity(a: str, b: str) -> float:
    """String similarity using SequenceMatcher — analogous to FileBot's
    NameSimilarityMetric which uses q-gram + block distance."""
    a_norm = normalize(a)
    b_norm = normalize(b)
    if not a_norm or not b_norm:
        return 0.0
    return SequenceMatcher(None, a_norm, b_norm).ratio()


def common_sequence_length(a: str, b: str) -> float:
    """Find longest common word sequence — ported from FileBot's
    CommonSequenceMatcher. Returns ratio of common words to total."""
    tokens_a = tokenize(a)
    tokens_b = tokenize(b)
    if not tokens_a or not tokens_b:
        return 0.0

    sm = SequenceMatcher(None, tokens_a, tokens_b)
    match = sm.find_longest_match(0, len(tokens_a), 0, len(tokens_b))
    common_len = match.size
    max_len = max(len(tokens_a), len(tokens_b))
    return common_len / max_len if max_len > 0 else 0.0


def substring_match(a: str, b: str) -> float:
    """Check if one string is a substring of the other — analogous to
    FileBot's SubstringMetric."""
    a_norm = normalize(a)
    b_norm = normalize(b)
    if not a_norm or not b_norm:
        return 0.0
    if a_norm in b_norm or b_norm in a_norm:
        shorter = min(len(a_norm), len(b_norm))
        longer = max(len(a_norm), len(b_norm))
        return shorter / longer
    return 0.0


def season_episode_match(
    file_season: Optional[int],
    file_episode: Optional[int],
    meta_season: int,
    meta_episode: int,
) -> float:
    """Exact season/episode matching — ported from FileBot's
    SeasonEpisodeMetric. Returns 1.0 for exact, 0.5 for partial, -1.0 for mismatch."""
    if file_season is not None and file_episode is not None:
        if file_season == meta_season and file_episode == meta_episode:
            return 1.0
        if file_episode == meta_episode:
            return 0.5
        return -1.0
    if file_episode is not None:
        if file_episode == meta_episode:
            return 0.8
        return -0.5
    return 0.0


def absolute_episode_match(file_absolute: Optional[int], meta_absolute: int) -> float:
    """Absolute episode number matching (common for anime)."""
    if file_absolute is not None:
        if file_absolute == meta_absolute:
            return 0.8  # capped like FileBot
        return -0.5
    return 0.0


def year_match(file_year: Optional[int], meta_year: Optional[int]) -> float:
    """Year matching with ±1 tolerance."""
    if file_year is None or meta_year is None:
        return 0.0
    diff = abs(file_year - meta_year)
    if diff == 0:
        return 1.0
    if diff == 1:
        return 0.8
    return -0.5


# Human-readable labels for each metric, used by the breakdown view.
METRIC_LABELS = {
    "sxe": "Season/Episode",
    "abs": "Absolute number",
    "name": "Name similarity",
    "seq": "Word sequence",
    "sub": "Substring",
    "year": "Year",
}


def _score_components(
    file_name: str,
    file_season: Optional[int],
    file_episode: Optional[int],
    file_absolute: Optional[int],
    file_year: Optional[int],
    meta_name: str,
    meta_season: int = 0,
    meta_episode: int = 0,
    meta_absolute: int = 0,
    meta_year: Optional[int] = None,
) -> list[tuple[str, float, float]]:
    """Compute the individual (metric, value, weight) tuples that make up a
    cascade score. Shared by cascade_score() and cascade_breakdown() so the
    aggregate and the explanation can never drift apart."""

    scores: list[tuple[str, float, float]] = []

    # 1. Season/Episode match (highest weight)
    se = season_episode_match(file_season, file_episode, meta_season, meta_episode)
    if se != 0:
        scores.append(("sxe", se, 3.0))

    # 2. Absolute episode match
    ae = absolute_episode_match(file_absolute, meta_absolute)
    if ae != 0:
        scores.append(("abs", ae, 2.0))

    # 3. Name similarity
    ns = name_similarity(file_name, meta_name)
    scores.append(("name", ns, 2.0))

    # 4. Common sequence
    cs = common_sequence_length(file_name, meta_name)
    scores.append(("seq", cs, 1.5))

    # 5. Substring match
    ss = substring_match(file_name, meta_name)
    scores.append(("sub", ss, 1.0))

    # 6. Year match
    ym = year_match(file_year, meta_year)
    if ym != 0:
        scores.append(("year", ym, 1.0))

    return scores


def _aggregate(scores: list[tuple[str, float, float]]) -> float:
    """Weighted average of metric components, clamped to 0.0–1.0."""
    if not scores:
        return 0.0
    total_weight = sum(w for _, _, w in scores)
    weighted_sum = sum(s * w for _, s, w in scores)
    return max(0.0, min(1.0, weighted_sum / total_weight))


def cascade_score(
    file_name: str,
    file_season: Optional[int],
    file_episode: Optional[int],
    file_absolute: Optional[int],
    file_year: Optional[int],
    meta_name: str,
    meta_season: int = 0,
    meta_episode: int = 0,
    meta_absolute: int = 0,
    meta_year: Optional[int] = None,
) -> float:
    """Cascading similarity score — ported from FileBot's EpisodeMetrics cascade.
    Combines multiple metrics with weights, returns 0.0–1.0 overall confidence."""
    return _aggregate(_score_components(
        file_name, file_season, file_episode, file_absolute, file_year,
        meta_name, meta_season, meta_episode, meta_absolute, meta_year,
    ))


def cascade_breakdown(
    file_name: str,
    file_season: Optional[int],
    file_episode: Optional[int],
    file_absolute: Optional[int],
    file_year: Optional[int],
    meta_name: str,
    meta_season: int = 0,
    meta_episode: int = 0,
    meta_absolute: int = 0,
    meta_year: Optional[int] = None,
) -> dict:
    """Same computation as cascade_score(), but also returns the per-metric
    contributions so the UI can explain *why* a match was chosen."""
    scores = _score_components(
        file_name, file_season, file_episode, file_absolute, file_year,
        meta_name, meta_season, meta_episode, meta_absolute, meta_year,
    )
    return {
        "score": round(_aggregate(scores), 3),
        "components": [
            {
                "metric": name,
                "label": METRIC_LABELS.get(name, name),
                "value": round(value, 3),
                "weight": weight,
            }
            for (name, value, weight) in scores
        ],
    }


def find_best_match(
    file_name: str,
    file_season: Optional[int],
    file_episode: Optional[int],
    file_absolute: Optional[int],
    file_year: Optional[int],
    candidates: list[dict],
) -> Optional[dict]:
    """Find the best matching candidate from a list of metadata results.
    Each candidate should have: name, season, episode, (absolute, year).
    Returns the best match with score, or None."""

    best = None
    best_score = 0.0

    for candidate in candidates:
        score = cascade_score(
            file_name=file_name,
            file_season=file_season,
            file_episode=file_episode,
            file_absolute=file_absolute,
            file_year=file_year,
            meta_name=candidate.get("name", ""),
            meta_season=candidate.get("season", 0),
            meta_episode=candidate.get("episode", 0),
            meta_absolute=candidate.get("absolute", 0),
            meta_year=candidate.get("year"),
        )
        if score > best_score:
            best_score = score
            best = {**candidate, "_score": round(score, 3)}

    return best
