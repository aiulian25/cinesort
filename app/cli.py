"""Headless CLI — the same pipeline the web UI drives, without a browser.

    python -m app.cli scan   <folder>
    python -m app.cli match  <folder> [--template …] [--show-id N] [--json]
    python -m app.cli rename <folder> [--action move] [--yes] [--json]
    python -m app.cli watch --once

Importing app.main builds the FastAPI object but starts no server: load_config()
runs at import so API keys are available, and the startup hook that launches the
watch loop only fires under uvicorn. Every command therefore drives the exact
functions the HTTP endpoints drive — one implementation, two front doors.

Exit codes: 0 success · 1 error · 2 partial (something unmatched or failed) ·
3 ambiguous (a group needs --show-id / --movie-id).
"""

import argparse
import asyncio
import json
import sys
import uuid
from pathlib import Path
from typing import Optional

from app import __version__
from app import main as backend
from app.core.renamer import RenameAction

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_PARTIAL = 2
EXIT_AMBIGUOUS = 3

# Two polls are needed before a watch rule acts: it only touches files whose
# size held steady across consecutive scans, which is what stops it from
# renaming a half-finished download. The always-on loop gets that for free from
# its interval; a one-shot run has to wait deliberately.
DEFAULT_SETTLE_SECONDS = 10.0


def _err(message: str) -> None:
    sys.stderr.write(message + "\n")


def _out(message: str) -> None:
    sys.stdout.write(message + "\n")


def _note(message: str, as_json: bool) -> None:
    """Human commentary. Under --json it goes to stderr so stdout stays a
    single valid document for `jq`."""
    (sys.stderr if as_json else sys.stdout).write(message + "\n")


def _resolve_input_path(raw: str, action: str) -> Path:
    """Expand, resolve and scope-check one path.

    CINESORT_SCOPE_TO_BROWSE_ROOTS confines the file-touching HTTP endpoints;
    the CLI is another file-touching entry point into the same deployment, so
    it honours the same switch rather than quietly being the way around it.
    """
    path = Path(raw).expanduser().resolve()
    if not path.exists():
        raise ValueError(f"Path does not exist: {raw}")
    backend._require_within_roots(path, action)
    return path


# ── scan ──────────────────────────────────────────────────────────────────

def cmd_scan(args) -> int:
    target = _resolve_input_path(args.path, "Scanning")
    data = backend._scan_dir_sync(str(target), not args.no_recursive,
                                  {"seen": 0, "media": 0}, args.include_extras)
    files = data["files"]

    if args.json:
        _out(json.dumps(data, indent=2, default=str))
        return EXIT_OK

    if not files:
        _out("No media files found.")
        return EXIT_OK

    width = max(len(f["filename"]) for f in files)
    for f in files:
        season, episode = f.get("season"), f.get("episode")
        sxe = f"S{season:02d}E{episode:02d}" if season is not None and episode is not None else ""
        _out(f"{f['filename']:<{width}}  {f['media_type']:<7}  "
             f"{(f.get('clean_name') or ''):<32}  {sxe:<8}  {f.get('year') or ''}")
    skipped = data.get("skipped") or 0
    _out(f"\n{len(files)} media file(s)."
         + (f" {skipped} sample(s)/extra(s) skipped." if skipped else ""))
    return EXIT_OK


# ── match ─────────────────────────────────────────────────────────────────

def _match(args) -> tuple[dict, int]:
    """Scan + match. Returns (response, exit_code) using the same response
    shape as POST /api/match."""
    target = _resolve_input_path(args.path, "Scanning")
    destination = None
    if args.destination:
        destination = str(_resolve_input_path(args.destination, "The destination folder"))

    scan = backend._scan_dir_sync(str(target), not args.no_recursive,
                                  {"seen": 0, "media": 0}, args.include_extras)
    if scan.get("skipped"):
        _note(f"{scan['skipped']} sample(s)/extra(s) skipped "
              f"(--include-extras to keep them).", args.json)
    if not scan["files"]:
        _note("No media files found.", args.json)
        return {"results": [], "conflicts": [], "source_errors": {}}, EXIT_OK

    request = backend.MatchRequest(
        files=scan["files"],
        datasource=args.datasource,
        template=args.template,
        selected_show_id=args.show_id,
        selected_show_name=args.show_name,
        selected_movie_id=args.movie_id,
        selected_movie_source=args.movie_source,
        output_dir=destination,
    )
    data = asyncio.run(backend._match_files_impl(request, progress={}))

    if data.get("needs_selection"):
        return data, EXIT_AMBIGUOUS

    unmatched = sum(1 for r in data["results"] if not r["matched"])
    return data, (EXIT_PARTIAL if unmatched else EXIT_OK)


def _print_candidates(data: dict, as_json: bool) -> None:
    _note(f"Ambiguous — '{data.get('group_name')}' matches several records. "
          f"Re-run with --show-id (series) or --movie-id (film):", as_json)
    for candidate in data.get("candidates") or []:
        _note(f"  {candidate.get('id')}  {candidate.get('name') or candidate.get('title')}"
              f"  ({candidate.get('year') or '?'})", as_json)


def cmd_match(args) -> int:
    data, code = _match(args)

    if args.json:
        _out(json.dumps(data, indent=2, default=str))
        if code == EXIT_AMBIGUOUS:
            _print_candidates(data, True)
        return code

    if code == EXIT_AMBIGUOUS:
        _print_candidates(data, False)
        return code

    for result in data["results"]:
        if result["matched"]:
            _out(f"  ✓ {result['filename']}\n      → {result['new_name']}  ({result['score']})")
        else:
            _out(f"  ✗ {result['filename']}\n      {result.get('reason')}")
    for source, error in (data.get("source_errors") or {}).items():
        _note(f"{source}: {error}", False)
    return code


# ── rename ────────────────────────────────────────────────────────────────

def _confirm(prompt: str) -> bool:
    """Ask before touching files. A non-interactive caller that did not pass
    --yes is refused rather than prompted into a hang (cron, CI, docker exec
    without -t all land here)."""
    if not sys.stdin.isatty():
        _err("Refusing to rename without confirmation: stdin is not a terminal. "
             "Pass --yes to run unattended.")
        return False
    try:
        return input(prompt).strip().lower() in {"y", "yes"}
    except EOFError:
        return False


def cmd_rename(args) -> int:
    data, code = _match(args)
    if code == EXIT_AMBIGUOUS:
        _print_candidates(data, args.json)
        return code

    threshold = (args.min_confidence if args.min_confidence is not None
                 else backend._thresholds()[1])
    operations = [
        {"original": r["original"], "new_path": r["new_path"],
         "metadata": r.get("metadata"), "is_subtitle": bool(r.get("is_subtitle"))}
        for r in data["results"]
        if r["matched"] and r["new_path"] and r.get("score", 0) >= threshold
    ]
    held = len(data["results"]) - len(operations)

    conflicts = data.get("conflicts") or []
    if conflicts and not args.skip_conflicts:
        _err(f"{len(conflicts)} conflict(s) — resolve them in the UI, or re-run "
             f"with --skip-conflicts to rename everything else:")
        for conflict in conflicts:
            _err(f"  {conflict['message']}")
        return EXIT_ERROR
    if conflicts:
        contested = {c.get("destination") for c in conflicts}
        operations = [op for op in operations if op["new_path"] not in contested]
        held += len(contested)

    if not operations:
        _note(f"Nothing to rename ({held} file(s) left in place).", args.json)
        return EXIT_PARTIAL if held else EXIT_OK

    action = RenameAction(args.action)
    _note(f"{len(operations)} file(s) to {action.value}"
          + (f", {held} left in place (below {threshold} or conflicted)." if held else "."),
          args.json)
    if not args.json:
        for op in operations:
            _out(f"  {Path(op['original']).name}\n      → {op['new_path']}")

    if not args.yes and not _confirm(f"Proceed with {action.value}? [y/N] "):
        _note("Aborted.", args.json)
        return EXIT_ERROR

    batch_id = str(uuid.uuid4())
    results, history_entries = backend._rename_sync(
        operations, action, batch_id,
        {"current": 0, "total": len(operations), "file": ""})
    if history_entries:
        backend.history.add_batch(history_entries)

    sidecar_errors: list = []
    if args.write_sidecars and action != RenameAction.TEST:
        sidecar_errors = asyncio.run(backend._write_batch_sidecars(operations, results))

    succeeded = sum(1 for r in results if r["success"])
    payload = {"action": action.value, "batch_id": batch_id, "total": len(results),
               "success": succeeded, "failed": len(results) - succeeded,
               "held": held, "results": results, "sidecar_errors": sidecar_errors}

    if args.json:
        _out(json.dumps(payload, indent=2, default=str))
    else:
        for r in results:
            if not r["success"]:
                _out(f"  ✗ {r['original']}\n      {r['error']}")
        _out(f"\n{action.value}: {succeeded}/{len(results)} succeeded. batch {batch_id}")
        for error in sidecar_errors:
            _err(f"  sidecar: {error}")

    return EXIT_OK if succeeded == len(results) and not held else EXIT_PARTIAL


# ── watch ─────────────────────────────────────────────────────────────────

async def _watch_once(settle_seconds: float) -> None:
    """One pass over every enabled rule.

    Two scans, `settle_seconds` apart: a watch rule only acts on files whose
    size held steady between consecutive polls, and a fresh process starts with
    no previous sizes recorded. Skipping the wait would either do nothing at
    all or defeat the half-finished-download guard.
    """
    rules = [rule for rule in backend.load_watches() if rule.get("enabled", True)]
    if not rules:
        return
    for rule in rules:
        await backend._watch_one(rule)
    if settle_seconds > 0:
        await asyncio.sleep(settle_seconds)
        for rule in rules:
            await backend._watch_one(rule)


def cmd_watch(args) -> int:
    if not args.once:
        _err("Only --once is supported: the always-on loop belongs to the server "
             "(run the app, or schedule this command from cron/systemd).")
        return EXIT_ERROR

    rules = [rule for rule in backend.load_watches() if rule.get("enabled", True)]
    if not rules:
        _note("No enabled watch rules.", args.json)
        return EXIT_OK

    before = len(backend._watch_log)
    asyncio.run(_watch_once(args.settle_seconds))
    entries = backend._watch_log[before:]

    if args.json:
        _out(json.dumps({"rules": len(rules), "log": entries}, indent=2, default=str))
    else:
        for entry in entries:
            _out(f"  {entry['ts']}  {entry['folder']}: {entry['message']}")
        if not entries:
            _out(f"  {len(rules)} rule(s) checked, nothing to do.")
    return EXIT_OK


# ── argument parsing ──────────────────────────────────────────────────────

def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("path", help="folder or file to process")
    parser.add_argument("--no-recursive", action="store_true",
                        help="do not descend into subfolders")
    parser.add_argument("--include-extras", action="store_true",
                        help="also list release samples and Extras/Featurettes folders "
                             "(skipped by default — a sample collides with its own feature)")
    parser.add_argument("--json", action="store_true",
                        help="machine-readable output on stdout (notes go to stderr)")


def _add_match_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--datasource", default="tmdb",
                        choices=["tmdb", "tvmaze", "omdb", "musicbrainz"])
    parser.add_argument("--template", default=None,
                        help="naming template, e.g. '{name} - {s00e00} - {title}'")
    parser.add_argument("--destination", default=None,
                        help="organize into this folder instead of in place")
    parser.add_argument("--show-id", type=int, default=None,
                        help="match every series file against this show id")
    parser.add_argument("--show-name", default=None, help="title for --show-id")
    parser.add_argument("--movie-id", default=None,
                        help="match every film against this record id")
    parser.add_argument("--movie-source", default=None, choices=["tmdb", "omdb"],
                        help="provider --movie-id belongs to")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli",
        description="CineSort without a browser — scan, match and rename from a shell.")
    parser.add_argument("--version", action="version", version=f"CineSort {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    scan = sub.add_parser("scan", help="list detected media without contacting a provider")
    _add_common(scan)
    scan.set_defaults(func=cmd_scan)

    match = sub.add_parser("match", help="scan, then look up metadata and preview new names")
    _add_common(match)
    _add_match_options(match)
    match.set_defaults(func=cmd_match)

    rename = sub.add_parser("rename", help="match, then actually rename")
    _add_common(rename)
    _add_match_options(rename)
    rename.add_argument("--action", default="move",
                        choices=sorted(a.value for a in RenameAction),
                        help="'test' is a dry run (default: move)")
    rename.add_argument("--yes", "-y", action="store_true", help="skip the confirmation")
    rename.add_argument("--min-confidence", type=float, default=None,
                        help="score floor (default: the app's review threshold)")
    rename.add_argument("--skip-conflicts", action="store_true",
                        help="rename everything that is not contested instead of refusing")
    rename.add_argument("--write-sidecars", action="store_true",
                        help="also write Kodi/Jellyfin .nfo and poster art")
    rename.set_defaults(func=cmd_rename)

    watch = sub.add_parser("watch", help="run the saved watch rules once and exit")
    watch.add_argument("--once", action="store_true", required=True,
                       help="required: this command never loops")
    watch.add_argument("--settle-seconds", type=float, default=DEFAULT_SETTLE_SECONDS,
                       help="gap between the two size polls that protect in-progress "
                            f"downloads (default {DEFAULT_SETTLE_SECONDS:g}; 0 disables)")
    watch.add_argument("--json", action="store_true")
    watch.set_defaults(func=cmd_watch)

    return parser


def main(argv: Optional[list] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        _err("Interrupted.")
        return EXIT_ERROR
    except Exception as exc:
        # _sanitize_error strips provider key params: a failing TMDb URL must
        # not put the user's API key into a cron mail or a CI log.
        _err(backend._sanitize_error(exc))
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
