"""Quality upgrades that displace an existing file — the F22 seam.

This is the most destructive thing the app does: it puts a new file where one
the user already had is sitting. The whole feature rests on one invariant —
the old file is MOVED aside, never deleted — and on the failure paths keeping
that promise.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.renamer import (   # noqa: E402
    RenameAction, execute_rename, park_existing,
)


@pytest.fixture
def upgrade(tmp_path):
    """A 2160p download and the 720p copy already in the library."""
    source = tmp_path / "in" / "Movie.2010.2160p.mkv"
    source.parent.mkdir()
    source.write_bytes(b"new 4k content")
    destination = tmp_path / "lib" / "Movie (2010).mkv"
    destination.parent.mkdir()
    destination.write_bytes(b"old 720p content")
    return source, destination


# ── the invariant ────────────────────────────────────────────────────────

def test_the_old_file_is_moved_aside_never_deleted(upgrade):
    source, destination = upgrade
    result = execute_rename(source, destination, RenameAction.MOVE, replace_existing=True)

    assert result.success
    assert destination.read_bytes() == b"new 4k content"
    assert result.parked is not None
    assert result.parked.read_bytes() == b"old 720p content"
    assert result.parked.parent == destination.parent
    assert ".replaced-" in result.parked.name
    assert result.parked.suffix == ".mkv"


def test_without_the_flag_nothing_is_touched(upgrade):
    """The default is still a refusal — an upgrade is opt-in per operation."""
    source, destination = upgrade
    result = execute_rename(source, destination, RenameAction.MOVE)

    assert result.success is False
    assert "already exists" in result.error
    assert destination.read_bytes() == b"old 720p content"
    assert source.exists()
    assert result.parked is None


def test_a_second_upgrade_in_the_same_second_does_not_clobber_the_first(tmp_path):
    destination = tmp_path / "Movie.mkv"
    destination.write_bytes(b"first")
    first = park_existing(destination)

    destination.write_bytes(b"second")
    second = park_existing(destination)

    assert first != second
    assert first.read_bytes() == b"first"
    assert second.read_bytes() == b"second"


# ── the failure paths keep the promise ───────────────────────────────────

def test_a_failed_upgrade_puts_the_original_back(upgrade, monkeypatch):
    """Better the old file back in place than an empty destination and a
    stamped orphan beside it."""
    source, destination = upgrade

    def boom(*args, **kwargs):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr("app.core.renamer.shutil.move", boom)
    result = execute_rename(source, destination, RenameAction.MOVE, replace_existing=True)

    assert result.success is False
    assert destination.read_bytes() == b"old 720p content"
    assert not list(destination.parent.glob("*.replaced-*"))


def test_a_non_oserror_failure_also_restores(upgrade, monkeypatch):
    source, destination = upgrade
    monkeypatch.setattr("app.core.renamer.shutil.move",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))

    result = execute_rename(source, destination, RenameAction.MOVE, replace_existing=True)

    assert result.success is False
    assert destination.read_bytes() == b"old 720p content"
    assert not list(destination.parent.glob("*.replaced-*"))


def test_the_errno_message_still_survives_the_restore(upgrade, monkeypatch):
    """The restore must not shadow the friendly error: OSError has to reach its
    own handler, not a catch-all above it."""
    source, destination = upgrade
    monkeypatch.setattr("app.core.renamer.shutil.move",
                        lambda *a, **k: (_ for _ in ()).throw(OSError(28, "nope")))

    result = execute_rename(source, destination, RenameAction.MOVE, replace_existing=True)
    assert "No space left on the target device." == result.error


# ── unaffected paths ─────────────────────────────────────────────────────

def test_renaming_a_file_onto_itself_is_still_a_no_op(tmp_path):
    path = tmp_path / "Movie.mkv"
    path.write_bytes(b"same")
    result = execute_rename(path, path, RenameAction.MOVE, replace_existing=True)

    assert result.success and result.parked is None
    assert path.read_bytes() == b"same"


def test_a_free_destination_never_parks_anything(tmp_path):
    source = tmp_path / "a.mkv"
    source.write_bytes(b"x")
    result = execute_rename(source, tmp_path / "b.mkv", RenameAction.MOVE,
                            replace_existing=True)
    assert result.success and result.parked is None


@pytest.mark.parametrize("action", [RenameAction.COPY, RenameAction.HARDLINK])
def test_the_upgrade_works_for_copies_and_links_too(upgrade, action):
    source, destination = upgrade
    result = execute_rename(source, destination, action, replace_existing=True)

    assert result.success
    assert destination.read_bytes() == b"new 4k content"
    assert result.parked.read_bytes() == b"old 720p content"
    assert source.exists()      # copy/link leave the source alone


# ── F10: copy-on-write reflink ───────────────────────────────────────────
#
# The point of this action is saving disk: "=always" must fail rather than
# silently fall back to a full byte copy, because a user who chose it to avoid
# duplicating 40 GB would otherwise spend it without being told.

def test_on_a_filesystem_without_reflinks_it_fails_actionably(tmp_path):
    """ext4/tmpfs — where most of these tests run, and where a NAS user on the
    wrong volume will land."""
    source = tmp_path / "a.mkv"
    source.write_bytes(b"data")
    result = execute_rename(source, tmp_path / "b.mkv", RenameAction.REFLINK)

    assert result.success is False
    assert "reflink" in result.error.lower()
    assert not (tmp_path / "b.mkv").exists()   # nothing half-created
    assert source.exists()


def test_the_error_names_what_to_use_instead(tmp_path):
    source = tmp_path / "a.mkv"
    source.write_bytes(b"data")
    error = execute_rename(source, tmp_path / "b.mkv", RenameAction.REFLINK).error
    assert "copy" in error.lower() and "move" in error.lower()


def test_it_never_silently_falls_back_to_a_full_copy(tmp_path, monkeypatch):
    """The guard that matters: `--reflink=always`, never `=auto`."""
    seen = {}

    def fake_run(argv, **kwargs):
        seen["argv"] = argv
        class Result:
            returncode = 0
            stderr = ""
        return Result()

    monkeypatch.setattr("app.core.renamer.subprocess.run", fake_run)
    source = tmp_path / "a.mkv"
    source.write_bytes(b"data")
    execute_rename(source, tmp_path / "b.mkv", RenameAction.REFLINK)

    assert "--reflink=always" in seen["argv"]
    assert not any(a.startswith("--reflink=auto") for a in seen["argv"])
    # "--" before the operands: a filename beginning with "-" is a file, not a flag.
    assert seen["argv"].index("--") < seen["argv"].index(str(source))


def test_a_successful_clone_reports_success(tmp_path, monkeypatch):
    """The success path cannot be exercised for real here (no btrfs/XFS on this
    machine), so the wiring is verified against a stubbed clone."""
    source = tmp_path / "a.mkv"
    source.write_bytes(b"data")
    destination = tmp_path / "b.mkv"

    def fake_run(argv, **kwargs):
        Path(argv[-1]).write_bytes(Path(argv[-2]).read_bytes())
        class Result:
            returncode = 0
            stderr = ""
        return Result()

    monkeypatch.setattr("app.core.renamer.subprocess.run", fake_run)
    result = execute_rename(source, destination, RenameAction.REFLINK)

    assert result.success and result.error is None
    assert destination.read_bytes() == b"data"
    assert source.exists()          # a copy, not a move


def test_a_missing_cp_is_reported_not_a_traceback(tmp_path, monkeypatch):
    monkeypatch.setattr("app.core.renamer.shutil.which", lambda name: None)
    source = tmp_path / "a.mkv"
    source.write_bytes(b"data")

    result = execute_rename(source, tmp_path / "b.mkv", RenameAction.REFLINK)
    assert result.success is False
    assert "coreutils" in result.error


def test_a_hung_clone_does_not_wedge_the_batch(tmp_path, monkeypatch):
    import subprocess as sp

    def fake_run(argv, **kwargs):
        raise sp.TimeoutExpired(argv, kwargs.get("timeout", 60))

    monkeypatch.setattr("app.core.renamer.subprocess.run", fake_run)
    source = tmp_path / "a.mkv"
    source.write_bytes(b"data")

    result = execute_rename(source, tmp_path / "b.mkv", RenameAction.REFLINK)
    assert result.success is False
    assert "timed out" in result.error.lower()


def test_every_action_has_a_label(tmp_path):
    """The UI builds its dropdown from ACTION_LABELS; a new action missing one
    is how KEEPLINK stayed unreachable for months."""
    import app.main as main
    assert {a for a in RenameAction} == set(main.ACTION_LABELS)


def test_undo_of_a_reflink_removes_the_clone(tmp_path):
    """A reflink creates a new INDEPENDENT file, so undo deletes it — the same
    rule as copy, not the move rule that would restore an original."""
    from app.core.history import HistoryEntry, RenameHistory

    source = tmp_path / "a.mkv"
    source.write_bytes(b"data")
    clone = tmp_path / "b.mkv"
    clone.write_bytes(b"data")

    store = RenameHistory(tmp_path / "h.json")
    store.add_batch([HistoryEntry(id="r1", timestamp="t", action="reflink",
                                  original=str(source), destination=str(clone),
                                  success=True, batch_id="b1")])
    outcomes = store.undo_batch("b1")

    assert outcomes[0]["success"] is True
    assert not clone.exists()
    assert source.exists()
