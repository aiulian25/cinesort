"""Headless CLI — the F18 seam.

Runs the real entry point in a subprocess so what is tested is what a cron job
or `docker exec` actually gets: argv parsing, exit codes, and the stdout/stderr
split that lets `--json` be piped into jq.

Offline by design — every test either avoids providers entirely (scan) or runs
with the API keys cleared, so the suite never depends on TMDb being reachable.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

EXIT_OK, EXIT_ERROR, EXIT_PARTIAL, EXIT_AMBIGUOUS = 0, 1, 2, 3


@pytest.fixture
def library(tmp_path):
    """A folder the detector classifies both ways, plus an isolated data dir so
    no test can touch the developer's real history or watch rules."""
    media = tmp_path / "media"
    media.mkdir()
    (media / "Show.S01E02.mkv").write_bytes(b"\0" * 16)
    (media / "Movie.2010.mkv").write_bytes(b"\0" * 16)
    (tmp_path / "data").mkdir()
    return media


def run_cli(*args, cwd=None, env=None, stdin=subprocess.DEVNULL):
    environment = {
        **os.environ,
        # No provider calls, no shared state with the developer's install.
        "TMDB_API_KEY": "", "OMDB_API_KEY": "",
        "CINESORT_DATA_DIR": str(Path(cwd or ".") / "data") if cwd else "",
        "CINESORT_UPDATE_CHECK": "0",
        **(env or {}),
    }
    return subprocess.run(
        [sys.executable, "-m", "app.cli", *args],
        cwd=str(ROOT), env=environment, stdin=stdin,
        capture_output=True, text=True, timeout=120)


# ── scan ──────────────────────────────────────────────────────────────────

def test_scan_lists_both_media_types(library, tmp_path):
    proc = run_cli("scan", str(library), cwd=tmp_path)
    assert proc.returncode == EXIT_OK, proc.stderr
    assert "series" in proc.stdout
    assert "movie" in proc.stdout
    assert "S01E02" in proc.stdout


def test_scan_json_is_parseable(library, tmp_path):
    proc = run_cli("scan", str(library), "--json", cwd=tmp_path)
    assert proc.returncode == EXIT_OK, proc.stderr
    data = json.loads(proc.stdout)
    assert data["count"] == 2
    assert {f["media_type"] for f in data["files"]} == {"series", "movie"}


def test_scan_of_a_missing_path_is_an_error_not_a_traceback(tmp_path):
    proc = run_cli("scan", str(tmp_path / "nope"), cwd=tmp_path)
    assert proc.returncode == EXIT_ERROR
    assert "Path does not exist" in proc.stderr
    assert "Traceback" not in proc.stderr


# ── match ─────────────────────────────────────────────────────────────────

def test_match_without_providers_reports_partial_and_valid_json(library, tmp_path):
    """No API key configured: every file is unmatched, which is exit 2 — and
    stdout must still be a single valid JSON document for jq."""
    proc = run_cli("match", str(library), "--json", cwd=tmp_path)
    assert proc.returncode == EXIT_PARTIAL, proc.stderr
    data = json.loads(proc.stdout)
    assert len(data["results"]) == 2
    assert all(r["matched"] is False for r in data["results"])


def test_empty_folder_matches_nothing_and_succeeds(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    (tmp_path / "data").mkdir()
    proc = run_cli("match", str(empty), "--json", cwd=tmp_path)
    assert proc.returncode == EXIT_OK, proc.stderr
    assert json.loads(proc.stdout)["results"] == []
    # The human note went to stderr, leaving stdout a clean document.
    assert "No media files" in proc.stderr


# ── rename ────────────────────────────────────────────────────────────────

def test_rename_without_matches_touches_nothing(library, tmp_path):
    """No provider configured means nothing is renameable — the command must
    say so and leave the folder exactly as it found it, not fall through to a
    confirmation prompt over an empty plan."""
    proc = run_cli("rename", str(library), cwd=tmp_path)
    assert proc.returncode == EXIT_PARTIAL
    assert "Nothing to rename" in proc.stdout
    assert (library / "Show.S01E02.mkv").exists()
    assert (library / "Movie.2010.mkv").exists()


def test_confirmation_refuses_when_stdin_is_not_a_terminal(monkeypatch, capsys):
    """The cron-safety guard: a non-interactive caller that forgot --yes is
    refused outright. Prompting would hang the job forever; assuming yes would
    reorganize a library nobody approved."""
    from app import cli

    class NotATerminal:
        def isatty(self):
            return False

    monkeypatch.setattr(cli.sys, "stdin", NotATerminal())
    assert cli._confirm("Proceed? [y/N] ") is False
    assert "not a terminal" in capsys.readouterr().err


@pytest.mark.parametrize("answer, expected", [
    ("y\n", True), ("yes\n", True), ("Y\n", True),
    ("n\n", False), ("\n", False), ("maybe\n", False),
])
def test_confirmation_only_accepts_an_explicit_yes(monkeypatch, answer, expected):
    import io
    from app import cli

    class Terminal(io.StringIO):
        def isatty(self):
            return True

    monkeypatch.setattr(cli.sys, "stdin", Terminal(answer))
    monkeypatch.setattr("builtins.input", lambda _prompt="": cli.sys.stdin.readline().rstrip("\n"))
    assert cli._confirm("Proceed? [y/N] ") is expected


def test_rename_action_choices_track_the_enum(tmp_path):
    from app.core.renamer import RenameAction
    proc = run_cli("rename", "--help", cwd=tmp_path)
    assert proc.returncode == EXIT_OK
    for action in RenameAction:
        assert action.value in proc.stdout


# ── scoping parity ────────────────────────────────────────────────────────

def test_scoping_confines_the_cli_exactly_like_the_http_api(library, tmp_path):
    """CINESORT_SCOPE_TO_BROWSE_ROOTS hardens the file-touching endpoints; the
    CLI is another door into the same deployment, not a way around it."""
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    env = {"CINESORT_SCOPE_TO_BROWSE_ROOTS": "1", "CINESORT_BROWSE_ROOTS": str(allowed)}

    refused = run_cli("scan", str(library), cwd=tmp_path, env=env)
    assert refused.returncode == EXIT_ERROR
    assert "restricted to the configured roots" in refused.stderr

    permitted = run_cli("scan", str(allowed), cwd=tmp_path, env=env)
    assert permitted.returncode == EXIT_OK, permitted.stderr


# ── watch ─────────────────────────────────────────────────────────────────

def test_watch_requires_once(tmp_path):
    proc = run_cli("watch", cwd=tmp_path)
    assert proc.returncode != EXIT_OK
    assert "--once" in proc.stderr


def test_watch_once_with_no_rules_is_a_clean_no_op(tmp_path):
    (tmp_path / "data").mkdir()
    proc = run_cli("watch", "--once", "--settle-seconds", "0", cwd=tmp_path)
    assert proc.returncode == EXIT_OK, proc.stderr


# ── entry point ───────────────────────────────────────────────────────────

def test_help_lists_every_subcommand(tmp_path):
    proc = run_cli("--help", cwd=tmp_path)
    assert proc.returncode == EXIT_OK
    for command in ("scan", "match", "rename", "watch"):
        assert command in proc.stdout


# ── F4: sample/extras exclusion through the real scan path ───────────────

@pytest.fixture
def library_with_samples(tmp_path):
    media = tmp_path / "media"
    (media / "Movie (2010)" / "Featurettes").mkdir(parents=True)
    (media / "Movie.2010.1080p.mkv").write_bytes(b"\0" * 16)
    (media / "Movie.2010.1080p.sample.mkv").write_bytes(b"\0" * 16)
    (media / "Sample.This.2015.1080p.mkv").write_bytes(b"\0" * 16)
    (media / "Movie (2010)" / "Featurettes" / "making-of.mkv").write_bytes(b"\0" * 16)
    (tmp_path / "data").mkdir()
    return media


def test_scan_skips_samples_and_extras_by_default(library_with_samples, tmp_path):
    proc = run_cli("scan", str(library_with_samples), "--json", cwd=tmp_path)
    assert proc.returncode == EXIT_OK, proc.stderr
    data = json.loads(proc.stdout)
    names = {f["filename"] for f in data["files"]}

    assert data["skipped"] == 2
    assert names == {"Movie.2010.1080p.mkv", "Sample.This.2015.1080p.mkv"}


def test_include_extras_keeps_everything(library_with_samples, tmp_path):
    proc = run_cli("scan", str(library_with_samples), "--include-extras", "--json", cwd=tmp_path)
    assert proc.returncode == EXIT_OK, proc.stderr
    data = json.loads(proc.stdout)
    assert data["count"] == 4
    assert data["skipped"] == 0


def test_scanning_the_extras_folder_directly_returns_its_files(library_with_samples, tmp_path):
    """The exclusion must never swallow the folder the user actually named."""
    featurettes = library_with_samples / "Movie (2010)" / "Featurettes"
    proc = run_cli("scan", str(featurettes), "--json", cwd=tmp_path)
    assert proc.returncode == EXIT_OK, proc.stderr
    data = json.loads(proc.stdout)
    assert [f["filename"] for f in data["files"]] == ["making-of.mkv"]
