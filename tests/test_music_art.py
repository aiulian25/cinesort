"""Album art travelling with its tracks — the F23 seam.

Art is a file the user never selected, so it moves under a narrow contract:
MOVE only, only once this batch emptied the folder of audio, and never over an
existing file. Every move is a history entry, so undo puts it back.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.main as main                              # noqa: E402
from app.core.renamer import RenameAction            # noqa: E402


@pytest.fixture
def album(tmp_path):
    source = tmp_path / "incoming" / "Nevermind"
    source.mkdir(parents=True)
    for name in ("01 - Track.flac", "02 - Other.flac"):
        (source / name).write_bytes(b"\0" * 8)
    (source / "cover.jpg").write_bytes(b"\xff\xd8art")
    destination = tmp_path / "library" / "Nirvana" / "Nevermind"
    return source, destination


def run_rename(source, destination, action=RenameAction.MOVE, tracks=("01 - Track.flac", "02 - Other.flac")):
    operations = [{"original": str(source / t), "new_path": str(destination / t)} for t in tracks]
    return main._rename_sync(operations, action, "batch-1", {"current": 0, "total": len(operations), "file": ""})


def test_art_follows_the_last_track_out(album):
    source, destination = album
    results, history = run_rename(source, destination)

    assert all(r["success"] for r in results)
    assert (destination / "cover.jpg").read_bytes() == b"\xff\xd8art"
    assert not (source / "cover.jpg").exists()
    art_entries = [h for h in history if h.destination.endswith("cover.jpg")]
    assert len(art_entries) == 1 and art_entries[0].success is True


def test_art_stays_when_a_track_stays(album):
    """Art beside tracks that did not move belongs to those tracks."""
    source, destination = album
    run_rename(source, destination, tracks=("01 - Track.flac",))

    assert (source / "cover.jpg").exists()
    assert not (destination / "cover.jpg").exists()


@pytest.mark.parametrize("action", [RenameAction.COPY, RenameAction.HARDLINK, RenameAction.TEST])
def test_art_never_moves_for_a_non_move_action(album, action):
    """A copy or a link leaves the source album whole — taking its art would
    quietly break the very folder the user chose to preserve."""
    source, destination = album
    run_rename(source, destination, action=action)
    assert (source / "cover.jpg").exists()


def test_existing_art_at_the_destination_is_never_overwritten(album):
    source, destination = album
    destination.mkdir(parents=True)
    (destination / "cover.jpg").write_bytes(b"mine")

    run_rename(source, destination)

    assert (destination / "cover.jpg").read_bytes() == b"mine"
    assert (source / "cover.jpg").exists()


def test_a_folder_with_no_art_is_a_clean_no_op(tmp_path):
    source = tmp_path / "in" / "Album"
    source.mkdir(parents=True)
    (source / "01 - Track.flac").write_bytes(b"\0")
    destination = tmp_path / "out" / "Artist" / "Album"

    results, history = run_rename(source, destination, tracks=("01 - Track.flac",))
    assert all(r["success"] for r in results)
    assert len(history) == 1     # the track, and nothing else


def test_the_art_move_is_undoable(album):
    source, destination = album
    _, history = run_rename(source, destination)
    art = next(h for h in history if h.destination.endswith("cover.jpg"))

    ok, message = main.history._undo_entry([], art)
    assert ok, message
    assert (source / "cover.jpg").exists()
    assert not (destination / "cover.jpg").exists()
