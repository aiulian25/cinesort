"""Remembered matches — the F2 seam.

The watch-folder log has always promised "match it once manually, then rename
stays automatic". Nothing persisted the pick, so the next cycle asked again,
forever. These tests pin the memory that makes the promise true, and the two
rules that keep it from becoming a liability: only an EXPLICIT pick is
remembered (never an auto-match, never an alias re-saving itself), and a
malformed store degrades to "no aliases" rather than breaking a match.
"""

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.aliases import (   # noqa: E402
    MAX_ALIASES, alias_key, aliases_file, forget_alias, load_aliases, save_alias,
)
from app.core.cache import provider_cache   # noqa: E402
import app.main as main                     # noqa: E402
from tests.test_match_overrides import (     # noqa: E402
    StubOMDb, StubTMDb, episode_file, movie_file,
)

SERIES_ALIAS = {"media": "series", "datasource": "tmdb", "id": 1396,
                "name": "Breaking Bad", "year": 2008}


@pytest.fixture(autouse=True)
def isolated_config(monkeypatch, tmp_path):
    """config._config_dir() reads CINESORT_DATA_DIR on every call, so this
    redirects aliases.json into tmp for the duration of one test — the suite
    must never write into the developer's ~/.config/cinesort."""
    monkeypatch.setenv("CINESORT_DATA_DIR", str(tmp_path))
    provider_cache.clear()
    monkeypatch.setattr(main, "tmdb", StubTMDb())
    monkeypatch.setattr(main, "omdb", StubOMDb())
    yield
    provider_cache.clear()


def run_match(**kwargs):
    return asyncio.run(main._match_files_impl(main.MatchRequest(**kwargs), progress={}))


# ── storage ───────────────────────────────────────────────────────────────

def test_save_and_load_round_trip(tmp_path):
    save_alias("Breaking Bad", SERIES_ALIAS)
    stored = load_aliases()

    assert list(stored) == ["breakingbad"]
    assert stored["breakingbad"]["id"] == 1396
    assert stored["breakingbad"]["saved"]          # stamped on save
    assert aliases_file().parent == tmp_path / "config"


def test_the_key_survives_punctuation_case_and_accents():
    """A pick made on "Marvel's Daredevil" must be found by the same title
    however the next file spells it."""
    save_alias("Marvel's Daredevil", {**SERIES_ALIAS, "name": "Daredevil"})
    for spelling in ["marvels   daredevil", "MARVELS DAREDEVIL", "Marvel.s-Daredevil"]:
        assert alias_key(spelling) in load_aliases(), spelling


@pytest.mark.parametrize("entry", [
    {"media": "movie", "datasource": "tvmaze", "id": 1, "name": "X"},   # films aren't on TVmaze
    {"media": "podcast", "datasource": "tmdb", "id": 1, "name": "X"},
    {"media": "series", "datasource": "tmdb", "id": 1, "name": "   "},
    {"media": "series", "datasource": "tmdb", "id": "", "name": "X"},
    "not a dict",
])
def test_unusable_entries_are_refused(entry):
    assert save_alias("Whatever", entry) is None
    assert load_aliases() == {}


def test_a_malformed_store_degrades_to_no_aliases():
    aliases_file().parent.mkdir(parents=True, exist_ok=True)
    aliases_file().write_text("{ this is not json", encoding="utf-8")
    assert load_aliases() == {}


def test_the_store_is_capped():
    for i in range(MAX_ALIASES + 5):
        save_alias(f"Show {i}", {**SERIES_ALIAS, "id": i})
    stored = load_aliases()
    assert len(stored) == MAX_ALIASES
    assert alias_key("Show 0") not in stored          # oldest dropped
    assert alias_key(f"Show {MAX_ALIASES + 4}") in stored


def test_forget_removes_one_entry():
    save_alias("Breaking Bad", SERIES_ALIAS)
    assert forget_alias("breakingbad") is True
    assert load_aliases() == {}
    assert forget_alias("breakingbad") is False


# ── the pipeline ──────────────────────────────────────────────────────────

def test_an_explicit_pick_is_remembered():
    run_match(files=[episode_file()], datasource="tmdb",
              selected_show_id=1396, selected_show_name="Breaking Bad")
    stored = load_aliases()
    assert stored["breakingbad"]["id"] == 1396
    assert stored["breakingbad"]["name"] == "Breaking Bad"
    assert stored["breakingbad"]["datasource"] == "tmdb"


def test_a_remembered_show_matches_without_being_asked_again():
    """The headline: no selected_show_id in the request, yet the match resolves
    to the remembered record and is flagged as a deliberate choice."""
    save_alias("Breaking Bad", SERIES_ALIAS)
    data = run_match(files=[episode_file()], datasource="tmdb")

    assert not data.get("needs_selection")
    result = data["results"][0]
    assert result["matched"] is True
    assert result["pinned"] is True
    assert result["new_name"] == "Breaking Bad - S01E01 - Pilot.mkv"


def test_forgetting_restores_the_prompt():
    save_alias("Breaking Bad", SERIES_ALIAS)
    assert run_match(files=[episode_file()], datasource="tmdb")["results"][0]["pinned"] is True

    forget_alias("breakingbad")
    after = run_match(files=[episode_file()], datasource="tmdb")
    row = after["results"][0] if after.get("results") else None
    if row is not None:
        assert row.get("pinned") is not True


def test_an_auto_match_is_never_remembered():
    """Only a pick the user actually made becomes an alias — otherwise a wrong
    guess would teach itself and never be re-examined."""
    run_match(files=[movie_file(clean_name="xzqvw", year=1955)], datasource="tmdb")
    assert load_aliases() == {}


def test_an_alias_hit_does_not_rewrite_itself():
    save_alias("Breaking Bad", SERIES_ALIAS)
    before = load_aliases()["breakingbad"]["saved"]
    run_match(files=[episode_file()], datasource="tmdb")
    assert load_aliases()["breakingbad"]["saved"] == before


def test_a_live_pick_outranks_a_remembered_one():
    save_alias("Breaking Bad", {**SERIES_ALIAS, "id": 999, "name": "Wrong Show"})
    data = run_match(files=[episode_file()], datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad")

    assert data["results"][0]["new_name"] == "Breaking Bad - S01E01 - Pilot.mkv"
    assert load_aliases()["breakingbad"]["id"] == 1396   # and it replaces the old one


def test_a_movie_alias_routes_a_series_detected_file(tmp_path):
    """The F16 rule applied to memory: a remembered pick outranks detection,
    because it IS a pick — just an older one."""
    save_alias("Breaking Bad", {"media": "movie", "datasource": "omdb",
                                "id": "tt1375666", "name": "Inception", "year": 2010})
    data = run_match(files=[episode_file()], datasource="tmdb")
    result = data["results"][0]

    assert result["matched"] is True
    assert "Inception" in result["new_name"]


def test_remembering_a_pick_releases_files_a_watch_rule_was_holding():
    """A long-running server keeps held files in the watch rule's in-memory
    done-set, so without this the very next cycle would skip the show the user
    just taught it — the promise would be true only after a restart."""
    main._watch_state["/some/watched/folder"] = {"sizes": {}, "done": {"/some/watched/folder/x.mkv"}}

    run_match(files=[episode_file()], datasource="tmdb",
              selected_show_id=1396, selected_show_name="Breaking Bad")

    assert main._watch_state == {}


def test_an_ordinary_match_leaves_watch_state_alone():
    """Clearing on every match would make the settle check useless — a
    half-copied download would look new on every single cycle."""
    state = {"sizes": {"/x": 1}, "done": {"/x"}}
    main._watch_state["/some/watched/folder"] = state

    run_match(files=[episode_file()], datasource="tmdb")

    assert main._watch_state["/some/watched/folder"] is state
