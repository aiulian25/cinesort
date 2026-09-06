"""Concurrent season fetching — the F19 seam.

A 39-season show cost 4.38 s of strictly serial round trips before the first
row could render, and every cache expiry paid it again. Concurrency is only
worth having if it keeps the three properties the serial loop had: identical
episode data, per-season failure isolation, and a bound on how hard the
provider is hit.
"""

import asyncio
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.main as main                        # noqa: E402
from app.core.cache import provider_cache      # noqa: E402

SEASON_LATENCY = 0.05


class Episode:
    def __init__(self, season, episode):
        self.season, self.episode = season, episode
        self.title = f"S{season}E{episode}"
        self.air_date = "2008-01-20"
        self.overview = ""


class SlowTMDb:
    """Counts concurrency the way a provider would experience it."""

    enabled = True

    def __init__(self, fail_on=(), latency=SEASON_LATENCY):
        self.fail_on = set(fail_on)
        self.latency = latency
        self.inflight = 0
        self.max_inflight = 0
        self.calls = []

    async def get_tv_season(self, tv_id, season):
        self.inflight += 1
        self.max_inflight = max(self.max_inflight, self.inflight)
        self.calls.append(season)
        try:
            await asyncio.sleep(self.latency)
            if season in self.fail_on:
                raise RuntimeError(f"season {season} unavailable")
            return [Episode(season, 1), Episode(season, 2)]
        finally:
            self.inflight -= 1


def seasons(count):
    return [{"season_number": n} for n in range(count)]


@pytest.fixture(autouse=True)
def clean_cache():
    provider_cache.clear()
    yield
    provider_cache.clear()


@pytest.fixture
def fetch(monkeypatch):
    """monkeypatch, not a bare assignment: a stub left in main.tmdb leaks into
    every later test in the session — post_settings calls tmdb.close() on
    whatever it finds there."""
    def run(stub, season_list, show_id=1396):
        monkeypatch.setattr(main, "tmdb", stub)
        return asyncio.run(main._fetch_seasons(show_id, season_list))
    return run


def test_every_season_is_fetched_and_flattened(fetch):
    stub = SlowTMDb()
    episodes, failures = fetch(stub, seasons(12))

    assert failures == {}
    assert len(episodes) == 24                      # 12 seasons x 2 episodes
    assert sorted(stub.calls) == list(range(12))
    assert episodes[0] == {"season": 0, "episode": 1, "title": "S0E1",
                           "air_date": "2008-01-20", "overview": ""}


def test_the_fetches_actually_overlap(fetch):
    """The whole point: 12 seasons must not cost 12 x latency."""
    stub = SlowTMDb()
    started = time.monotonic()
    fetch(stub, seasons(12))
    elapsed = time.monotonic() - started

    serial = 12 * SEASON_LATENCY
    assert elapsed < serial / 2, f"{elapsed:.2f}s is not meaningfully faster than {serial:.2f}s"
    assert stub.max_inflight > 1


def test_concurrency_stays_within_the_bound(fetch):
    """Unbounded gather over a 39-season show would open 39 sockets at once."""
    stub = SlowTMDb()
    fetch(stub, seasons(39))
    assert stub.max_inflight <= main.SEASON_FETCH_CONCURRENCY


def test_one_failing_season_loses_only_itself(fetch):
    """gather's default would cancel every sibling on the first exception."""
    stub = SlowTMDb(fail_on={3})
    episodes, failures = fetch(stub, seasons(6))

    assert list(failures) == [3]
    assert "season 3 unavailable" in failures[3]
    assert {e["season"] for e in episodes} == {0, 1, 2, 4, 5}


def test_results_keep_the_order_of_the_seasons_list(fetch):
    stub = SlowTMDb()
    episodes, _ = fetch(stub, [{"season_number": n} for n in (2, 0, 1)])
    assert [e["season"] for e in episodes] == [2, 2, 0, 0, 1, 1]


def test_duplicate_season_numbers_are_fetched_once(fetch):
    """Entries missing "season_number" all collapse to 0 — two concurrent
    fetches for one cache key, harmless but wasted."""
    stub = SlowTMDb()
    fetch(stub, [{}, {}, {"season_number": 1}])
    assert sorted(stub.calls) == [0, 1]


def test_an_empty_season_list_makes_no_calls(fetch):
    stub = SlowTMDb()
    assert fetch(stub, []) == ([], {})
    assert stub.calls == []


def test_a_second_fetch_is_served_from_cache(fetch):
    """Cache keys are unchanged, so a warm match still costs nothing."""
    stub = SlowTMDb()
    fetch(stub, seasons(4))
    assert sorted(stub.calls) == [0, 1, 2, 3]

    stub.calls.clear()
    episodes, failures = fetch(stub, seasons(4))
    assert stub.calls == []
    assert failures == {} and len(episodes) == 8
