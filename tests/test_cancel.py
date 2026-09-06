"""Cancelling a running match or scan — the F11 seam.

A 500-track music batch is >8 minutes at MusicBrainz's mandated 1 req/s, and a
recursive walk over a NAS share takes minutes; today the only escape is closing
the app while the backend keeps working. Cancellation is COOPERATIVE, so the
properties that matter are: work already done survives, nothing half-finished
is presented as complete, and a stale flag cannot kill the next run.
"""

import asyncio
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.main as main                                  # noqa: E402
from app.core.cache import provider_cache                # noqa: E402
from tests.test_match_overrides import (                  # noqa: E402
    StubOMDb, StubTMDb, episode_file, movie_file,
)


@pytest.fixture(autouse=True)
def clean(monkeypatch, tmp_path):
    monkeypatch.setenv("CINESORT_DATA_DIR", str(tmp_path))
    provider_cache.clear()
    monkeypatch.setattr(main, "tmdb", StubTMDb())
    monkeypatch.setattr(main, "omdb", StubOMDb())
    main.match_progress["cancel_requested"] = False
    main.scan_progress["cancel_requested"] = False
    yield
    main.match_progress["cancel_requested"] = False
    main.scan_progress["cancel_requested"] = False
    provider_cache.clear()


def run_match(**kwargs):
    return asyncio.run(main._match_files_impl(main.MatchRequest(**kwargs), progress=None))


# ── match ────────────────────────────────────────────────────────────────

def test_a_cancelled_match_still_answers_for_every_file():
    """The UI renders one row per file; a file silently missing from the
    response would read as the app losing it."""
    main.match_progress["cancel_requested"] = True
    files = [episode_file(path="/media/tv/A.S01E01.mkv"),
             movie_file(path="/media/movies/B.2010.mkv", clean_name="B")]

    data = run_match(files=files, datasource="tmdb")

    assert len(data["results"]) == 2
    assert all(r["reason"] == "Cancelled before matching" for r in data["results"])
    assert all(r["matched"] is False for r in data["results"])


def test_the_response_shape_is_unchanged_by_a_cancel():
    """Callers destructure conflicts/source_errors unconditionally."""
    main.match_progress["cancel_requested"] = True
    data = run_match(files=[episode_file()], datasource="tmdb")

    assert set(data) >= {"results", "conflicts", "source_errors"}
    assert data["conflicts"] == []


def test_work_already_done_is_kept():
    """Cancelling is not discarding: whatever matched before the click stays."""
    data = run_match(files=[episode_file()], datasource="tmdb",
                     selected_show_id=1396, selected_show_name="Breaking Bad",
                     template="{n} - {s00e00} - {t}")
    assert data["results"][0]["matched"] is True   # baseline, no cancel

    main.match_progress["cancel_requested"] = True
    cancelled = run_match(files=[episode_file()], datasource="tmdb",
                          selected_show_id=1396, selected_show_name="Breaking Bad")
    assert cancelled["results"][0]["reason"] == "Cancelled before matching"


def test_a_watch_run_is_not_affected_by_the_global_flag():
    """_watch_one passes its own progress dict, so an interactive cancel must
    not silently stop the background organizer."""
    main.match_progress["cancel_requested"] = True
    data = asyncio.run(main._match_files_impl(
        main.MatchRequest(files=[episode_file()], datasource="tmdb",
                          selected_show_id=1396, selected_show_name="Breaking Bad",
                          template="{n} - {s00e00} - {t}"),
        progress={}))                     # the private dict a watch rule uses
    assert data["results"][0]["matched"] is True


# ── the endpoints ────────────────────────────────────────────────────────

def test_the_endpoints_set_their_own_flag():
    client = TestClient(main.app)

    assert client.post("/api/match-cancel").json()["ok"] is True
    assert main.match_progress["cancel_requested"] is True
    assert main.scan_progress["cancel_requested"] is False

    assert client.post("/api/scan-cancel").json()["ok"] is True
    assert main.scan_progress["cancel_requested"] is True


def test_a_stale_cancel_cannot_kill_the_next_match():
    """A cancel POST landing just after a run finishes would otherwise sit in
    the flag and abort the next one before it started."""
    client = TestClient(main.app)
    client.post("/api/match-cancel")

    response = client.post("/api/match", json={
        "files": [episode_file()], "datasource": "tmdb",
        "selected_show_id": 1396, "selected_show_name": "Breaking Bad",
        "template": "{n} - {s00e00} - {t}"})

    assert response.json()["results"][0]["matched"] is True
    assert main.match_progress["cancel_requested"] is False


# ── scan ─────────────────────────────────────────────────────────────────

def test_a_cancelled_walk_returns_nothing_rather_than_half(tmp_path):
    """Half a folder presented as the whole folder is worse than no answer —
    the next thing the user does is press Match on it."""
    media = tmp_path / "media"
    media.mkdir()
    for n in range(5):
        (media / f"Show.S01E0{n}.mkv").write_bytes(b"\0")

    main.scan_progress["cancel_requested"] = True
    with pytest.raises(main.ScanCancelled):
        main._scan_dir_sync(str(media), True, main.scan_progress)


def test_the_scan_endpoint_reports_the_cancellation(tmp_path, monkeypatch):
    """The flag is cleared when a scan STARTS — you cannot cancel a run that has
    not begun — so a real cancel arrives mid-walk. This drives that path."""
    media = tmp_path / "media"
    media.mkdir()
    (media / "Show.S01E01.mkv").write_bytes(b"\0")

    def cancelled_walk(*args, **kwargs):
        raise main.ScanCancelled()

    monkeypatch.setattr(main, "_scan_dir_sync", cancelled_walk)
    body = TestClient(main.app).post("/api/scan", json={"path": str(media)}).json()

    assert body == {"count": 0, "files": [], "skipped": 0, "cancelled": True}
    assert main.scan_progress["active"] is False
    assert main.scan_progress["cancel_requested"] is False   # reset for the next run


def test_starting_a_scan_clears_a_stale_cancel(tmp_path):
    """Same guard as the match side: a late POST must not abort the next walk."""
    media = tmp_path / "media"
    media.mkdir()
    (media / "Show.S01E01.mkv").write_bytes(b"\0")

    main.scan_progress["cancel_requested"] = True
    body = TestClient(main.app).post("/api/scan", json={"path": str(media)}).json()

    assert body["count"] == 1
    assert "cancelled" not in body


def test_a_private_progress_dict_is_never_cancelled(tmp_path):
    """The watch loop and the CLI pass their own dict — a global cancel must
    not reach into a background scan."""
    media = tmp_path / "media"
    media.mkdir()
    (media / "Show.S01E01.mkv").write_bytes(b"\0")

    main.scan_progress["cancel_requested"] = True
    result = main._scan_dir_sync(str(media), True, {"seen": 0, "media": 0})
    assert result["count"] == 1
