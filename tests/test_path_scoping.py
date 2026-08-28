"""Guards for CINESORT_SCOPE_TO_BROWSE_ROOTS (F10).

Two properties matter and pull in opposite directions:
  * OFF (the default, and every desktop install) must behave exactly as before;
  * ON must refuse every way out of the roots — plain paths, `..`, and symlinks.

A security control is only worth having if both halves are pinned down, so both
are asserted here.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.main as main   # noqa: E402


@pytest.fixture
def library(tmp_path, monkeypatch):
    """An allowed root, a directory outside it, and a symlink bridging them."""
    inside, outside = tmp_path / "library", tmp_path / "private"
    inside.mkdir(); outside.mkdir()
    (inside / "movie.mkv").write_bytes(b"x")
    (outside / "secret.mkv").write_bytes(b"x")
    (inside / "escape").symlink_to(outside)
    monkeypatch.setenv("CINESORT_BROWSE_ROOTS", str(inside))
    return inside, outside


def enable(monkeypatch):
    monkeypatch.setenv("CINESORT_SCOPE_TO_BROWSE_ROOTS", "1")


def disable(monkeypatch):
    monkeypatch.delenv("CINESORT_SCOPE_TO_BROWSE_ROOTS", raising=False)


# ── OFF: the default must not change desktop behavior ─────────────────────

def test_disabled_by_default_allows_any_existing_path(library, monkeypatch):
    disable(monkeypatch)
    _, outside = library
    assert main.ScanRequest(path=str(outside)).path == str(outside.resolve())


def test_disabled_by_default_allows_any_rename_target(library, monkeypatch):
    disable(monkeypatch)
    _, outside = library
    main._require_within_roots(outside.resolve(), "The destination")   # no raise


# ── ON: inside is allowed, everything else is refused ─────────────────────

def test_enabled_allows_paths_inside_the_roots(library, monkeypatch):
    enable(monkeypatch)
    inside, _ = library
    assert main.ScanRequest(path=str(inside)).path == str(inside.resolve())


def test_enabled_rejects_a_path_outside_the_roots(library, monkeypatch):
    enable(monkeypatch)
    _, outside = library
    with pytest.raises(Exception):
        main.ScanRequest(path=str(outside))


def test_enabled_rejects_dot_dot_traversal(library, monkeypatch):
    enable(monkeypatch)
    inside, outside = library
    escape = inside / ".." / outside.name
    with pytest.raises(Exception):
        main.ScanRequest(path=str(escape))


def test_enabled_rejects_a_symlink_that_leaves_the_roots(library, monkeypatch):
    """The link itself lives inside the root; only resolve() reveals otherwise."""
    enable(monkeypatch)
    inside, _ = library
    with pytest.raises(Exception):
        main.ScanRequest(path=str(inside / "escape"))


def test_enabled_rejects_an_out_of_scope_destination(library, monkeypatch):
    enable(monkeypatch)
    _, outside = library
    with pytest.raises(ValueError):
        main._require_within_roots(outside.resolve(), "The destination")


def test_batch_scan_refuses_loudly_rather_than_dropping_paths(library, monkeypatch):
    """Silently discarding half a multi-folder selection reads as data loss."""
    enable(monkeypatch)
    inside, outside = library
    with pytest.raises(Exception):
        main.BatchScanRequest(paths=[str(inside), str(outside)])


def test_refusal_names_the_flag_and_the_roots(library, monkeypatch):
    """The message has to be actionable: an admin seeing it must know which
    setting caused it and what the allow-list is."""
    enable(monkeypatch)
    _, outside = library
    with pytest.raises(ValueError) as excinfo:
        main._require_within_roots(outside.resolve(), "The destination")
    message = str(excinfo.value)
    assert "CINESORT_SCOPE_TO_BROWSE_ROOTS" in message
    assert str(library[0]) in message
