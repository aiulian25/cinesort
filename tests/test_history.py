"""Rich history — the F13 seam.

The log recorded what CineSort DID and dropped why: the title, provider, id and
confidence that justified a rename were gone a second after they were computed.
The risky parts of fixing that are the two places untrusted text leaves the
app — a CSV a user opens in Excel, and a stored dict that came from a browser.
"""

import csv
import io
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.main as main                                  # noqa: E402
from app.core.history import HistoryEntry, RenameHistory  # noqa: E402

META = {"show": "Breaking Bad", "season": 1, "episode": 1, "title": "Pilot",
        "tmdbid": 1396, "show_year": 2008, "datasource": "tmdb"}


def entry(**overrides):
    base = dict(id="e1", timestamp="2026-09-06T12:00:00", action="move",
                original="/src/Breaking.Bad.S01E01.mkv",
                destination="/lib/Breaking Bad - S01E01 - Pilot.mkv",
                success=True, metadata=dict(META), confidence=0.97,
                datasource="tmdb", template="{n} - {s00e00} - {t}")
    return HistoryEntry(**{**base, **overrides})


@pytest.fixture
def store(tmp_path):
    return RenameHistory(tmp_path / "history.json")


# ── the record survives a round trip ─────────────────────────────────────

def test_the_reasoning_persists(store):
    store.add_batch([entry()])
    loaded = store.get_recent(10)[0]

    assert loaded.metadata["show"] == "Breaking Bad"
    assert loaded.confidence == 0.97
    assert loaded.datasource == "tmdb"
    assert loaded.template == "{n} - {s00e00} - {t}"


def test_a_file_written_before_this_feature_still_loads(store):
    store.history_file.write_text(json.dumps([{
        "id": "old", "timestamp": "t", "action": "move",
        "original": "/a", "destination": "/b", "success": True,
    }]), encoding="utf-8")

    loaded = store.get_recent(10)[0]
    assert loaded.metadata is None and loaded.confidence is None


def test_a_file_from_a_NEWER_build_is_not_destroyed(store):
    """HistoryEntry(**entry) used to raise on an unknown key; the except
    returned [] and the next add_batch OVERWROTE the file with just its own
    batch — silently destroying the audit trail on a downgrade."""
    store.history_file.write_text(json.dumps([{
        "id": "old", "timestamp": "t", "action": "move", "original": "/a",
        "destination": "/b", "success": True, "field_from_the_future": 42,
    }]), encoding="utf-8")

    assert len(store.get_recent(10)) == 1
    store.add_batch([entry(id="new")])
    assert {e.id for e in store.get_recent(10)} == {"old", "new"}


# ── what may be stored is bounded ────────────────────────────────────────

def test_only_known_metadata_keys_are_kept():
    kept = main._history_metadata({"show": "X", "junk": "y", "season": 2})
    assert kept == {"show": "X", "season": 2}


def test_long_values_are_truncated():
    kept = main._history_metadata({"show": "x" * 5000, "overview": "y" * 5000})
    assert len(kept["show"]) == main.MAX_HISTORY_TEXT
    assert len(kept["overview"]) == main.MAX_HISTORY_OVERVIEW


@pytest.mark.parametrize("value", ["not a dict", None, 42, []])
def test_an_unusable_metadata_payload_is_dropped(value):
    assert main._history_metadata(value) is None


@pytest.mark.parametrize("value, expected", [
    (0.97, 0.97), ("0.5", 0.5), (2, 1.0), (-1, 0.0), ("junk", None), (None, None),
])
def test_confidence_is_bounded(value, expected):
    assert main._bounded_confidence(value) == expected


# ── CSV export ───────────────────────────────────────────────────────────

def test_the_header_names_every_column():
    header = next(iter(main._history_rows([])))
    assert list(header) == list(main.CSV_COLUMNS)
    for column in ("id", "timestamp", "action", "original", "destination",
                   "success", "title", "season", "episode", "tmdbid", "imdbid",
                   "confidence"):
        assert column in header


def test_metadata_is_flattened_into_columns():
    rows = list(main._history_rows([entry()]))
    row = dict(zip(rows[0], rows[1]))

    assert row["title"] == "Breaking Bad"
    assert (row["season"], row["episode"]) == ("1", "1")
    assert row["tmdbid"] == "1396"
    assert row["confidence"] == "0.97"


@pytest.mark.parametrize("dangerous", [
    '=cmd|"/c calc"!A1',
    '+1+1',
    '-2+3',
    '@SUM(1:9)',
    '=HYPERLINK("http://evil","click")',
])
def test_a_formula_cell_is_neutralized(dangerous):
    """A media file can legitimately be named "=Movie.mkv", and a title comes
    from a provider. "Open it in Excel" is the point of the export, so a cell
    that would EXECUTE is a real hole (CWE-1236)."""
    rows = list(main._history_rows([entry(metadata={"title": dangerous})]))
    row = dict(zip(rows[0], rows[1]))
    assert row["title"].startswith("'")
    assert row["title"][1:] == dangerous


def test_ordinary_values_are_left_alone():
    rows = list(main._history_rows([entry()]))
    row = dict(zip(rows[0], rows[1]))
    assert not row["destination"].startswith("'")


def test_the_endpoint_serves_parseable_csv(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "history", RenameHistory(tmp_path / "h.json"))
    main.history.add_batch([entry()])

    response = TestClient(main.app).get("/api/history/export.csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "cinesort-history.csv" in response.headers["content-disposition"]

    rows = list(csv.reader(io.StringIO(response.text)))
    assert rows[0] == list(main.CSV_COLUMNS)
    assert rows[1][rows[0].index("title")] == "Breaking Bad"


# ── re-apply ─────────────────────────────────────────────────────────────

def test_reapply_renders_a_new_name_from_stored_metadata(tmp_path, monkeypatch):
    """No provider is contacted — the whole point is that it works offline and
    costs nothing."""
    monkeypatch.setattr(main, "history", RenameHistory(tmp_path / "h.json"))
    main.history.add_batch([entry()])

    result = TestClient(main.app).post(
        "/api/history/reapply", json={"id": "e1", "template": "{n} ({y})"}).json()
    assert result["new_name"] == "Breaking Bad (2008).mkv"
    assert result["unchanged"] is False


def test_reapply_reports_an_unchanged_name(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "history", RenameHistory(tmp_path / "h.json"))
    main.history.add_batch([entry()])

    result = TestClient(main.app).post(
        "/api/history/reapply", json={"id": "e1", "template": "{n} - {s00e00} - {t}"}).json()
    assert result["unchanged"] is True


def test_reapply_on_a_pre_feature_entry_is_a_clean_409(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "history", RenameHistory(tmp_path / "h.json"))
    main.history.add_batch([entry(metadata=None)])

    response = TestClient(main.app).post(
        "/api/history/reapply", json={"id": "e1", "template": "{n}"})
    assert response.status_code == 409
    assert "predates" in response.json()["detail"]


def test_reapply_on_an_unknown_id_is_404(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "history", RenameHistory(tmp_path / "h.json"))
    response = TestClient(main.app).post(
        "/api/history/reapply", json={"id": "nope", "template": "{n}"})
    assert response.status_code == 404


def test_bindings_cover_every_shipped_template(tmp_path):
    """A stored match must render under any preset the app ships, so a
    re-apply cannot produce an empty component."""
    from app.core.formatter import TEMPLATES, apply_template
    bindings = main.bindings_from_metadata(META)
    for name, template in TEMPLATES.items():
        if name == "music":
            continue
        assert apply_template(template, bindings).strip("/ ")


# ── F22: an upgrade writes two entries that undo in the right order ──────

def test_undoing_an_upgrade_restores_both_files(tmp_path, monkeypatch):
    """The displaced file's entry is appended FIRST, so undo_batch's reverse
    replay moves the incoming file back out of the way BEFORE restoring the
    original on top of it. Wrong order and the restore lands on an occupied
    destination."""
    from app.core.renamer import RenameAction, execute_rename

    library = tmp_path / "lib"
    library.mkdir()
    incoming = tmp_path / "in" / "Movie.2010.2160p.mkv"
    incoming.parent.mkdir()
    incoming.write_bytes(b"new 4k")
    destination = library / "Movie (2010).mkv"
    destination.write_bytes(b"old 720p")

    result = execute_rename(incoming, destination, RenameAction.MOVE, replace_existing=True)
    assert result.success and result.parked

    store = RenameHistory(tmp_path / "h.json")
    store.add_batch([
        HistoryEntry(id="parked", timestamp="t", action="move",
                     original=str(destination), destination=str(result.parked),
                     success=True, batch_id="b1"),
        HistoryEntry(id="main", timestamp="t", action="move",
                     original=str(incoming), destination=str(destination),
                     success=True, batch_id="b1"),
    ])

    outcomes = store.undo_batch("b1")
    assert [o["success"] for o in outcomes] == [True, True]

    assert destination.read_bytes() == b"old 720p"       # original back in place
    assert incoming.read_bytes() == b"new 4k"            # download back where it was
    assert not list(library.glob("*.replaced-*"))        # no orphan left behind
