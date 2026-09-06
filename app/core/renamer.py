"""
File rename actions — ported from FileBot's StandardRenameAction enum.
Supports move, copy, hardlink, symlink, and dry-run.
"""

import errno
import os
import shutil
import subprocess
from datetime import datetime
from enum import Enum
from pathlib import Path
from dataclasses import dataclass
from typing import Optional


class RenameAction(str, Enum):
    RENAME = "rename"    # in-place: atomic kernel rename, same directory, no folder creation
    MOVE = "move"
    COPY = "copy"
    # Copy-on-write clone: instant and free on btrfs/XFS-reflink/ZFS/APFS, and
    # unlike a hard link the two files are INDEPENDENT — editing one does not
    # change the other. The "keep seeding the original, organize a copy"
    # workflow at zero disk cost.
    REFLINK = "reflink"
    HARDLINK = "hardlink"
    SYMLINK = "symlink"
    KEEPLINK = "keeplink"  # move + leave symlink at original
    TEST = "test"  # dry run


@dataclass
class RenameResult:
    original: Path
    destination: Path
    action: RenameAction
    success: bool
    error: Optional[str] = None
    # Where the previous occupant of `destination` was moved to, when this
    # rename replaced one. Never a deletion — see park_existing.
    parked: Optional[Path] = None


def park_existing(destination: Path) -> Path:
    """Move whatever occupies `destination` aside and return where it went.

    A quality upgrade has to free the destination, and the only acceptable way
    to do that is to MOVE the old file, never to delete it: the user is one
    click from replacing a file they may have curated, and "undo" has to mean
    something. os.replace within the same directory is atomic, so there is no
    window where the old file exists under neither name.
    """
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    parked = destination.with_name(f"{destination.stem}.replaced-{stamp}{destination.suffix}")
    # A second replacement within the same second would collide — count up
    # rather than clobber the first one.
    counter = 2
    while parked.exists():
        parked = destination.with_name(
            f"{destination.stem}.replaced-{stamp}-{counter}{destination.suffix}")
        counter += 1
    os.replace(destination, parked)
    return parked


def _restore_parked(parked: Optional[Path], destination: Path) -> None:
    """Undo a park after the rename that displaced the file failed.

    A failed upgrade must not leave the user with neither file where they left
    it: better the old file back in place than an empty destination and a
    stamped orphan beside it. Best-effort — the caller is already reporting a
    more important error.
    """
    if parked is None:
        return
    try:
        os.replace(parked, destination)
    except OSError:
        pass


def execute_rename(
    source: Path,
    destination: Path,
    action: RenameAction = RenameAction.MOVE,
    replace_existing: bool = False,
) -> RenameResult:
    """Execute a rename operation.

    `replace_existing` turns "destination already exists" from a refusal into an
    upgrade: the old file is parked (moved aside, never deleted) and the new one
    takes its place. If the rename then fails, the parked file is put BACK — a
    failed upgrade must not leave the user with neither file where they left it.
    """

    # Set only when this rename displaced an existing file (replace_existing).
    parked: Optional[Path] = None

    if action == RenameAction.TEST:
        return RenameResult(
            original=source,
            destination=destination,
            action=action,
            success=True,
        )

    try:
        if action == RenameAction.RENAME:
            # Atomic in-place rename: only the filename changes, directory is never touched.
            # Uses os.rename() (POSIX rename(2)) — works on SMB/NFS, no cross-device issue,
            # no new folders created.
            dest_in_place = source.parent / destination.name
            if dest_in_place.exists() and dest_in_place.resolve() != source.resolve():
                return RenameResult(
                    original=source,
                    destination=dest_in_place,
                    action=action,
                    success=False,
                    error=f"Destination already exists: {dest_in_place}",
                )
            os.rename(source, dest_in_place)
            return RenameResult(
                original=source,
                destination=dest_in_place,
                action=action,
                success=True,
            )

        else:
            # For all non-RENAME actions, create the destination directory and check conflicts
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                if destination.resolve() == source.resolve():
                    return RenameResult(original=source, destination=destination, action=action, success=True)
                if replace_existing:
                    # Free the destination and fall through to the ordinary
                    # dispatch below; the except clauses restore it on failure.
                    parked = park_existing(destination)
                else:
                    return RenameResult(
                        original=source,
                        destination=destination,
                        action=action,
                        success=False,
                        error=f"Destination already exists: {destination}",
                    )

        if action == RenameAction.MOVE:
            shutil.move(str(source), str(destination))

        elif action == RenameAction.COPY:
            shutil.copy2(str(source), str(destination))

        elif action == RenameAction.REFLINK:
            _reflink_copy(source, destination)

        elif action == RenameAction.HARDLINK:
            os.link(str(source), str(destination))

        elif action == RenameAction.SYMLINK:
            _create_symlink(source, destination)

        elif action == RenameAction.KEEPLINK:
            shutil.move(str(source), str(destination))
            # Leave a symlink at the original location pointing to the new path
            try:
                _create_symlink(destination, source)
            except OSError:
                # Move already succeeded; best-effort symlink — swallow and report
                pass

        return RenameResult(
            original=source,
            destination=destination,
            action=action,
            success=True,
            parked=parked,
        )

    except OSError as exc:
        _restore_parked(parked, destination)
        if exc.errno == errno.EOPNOTSUPP:
            msg = (
                "The target filesystem does not support symbolic links or "
                "copy-on-write reflinks (e.g. ext4, SMB/CIFS, FAT32, or exFAT). "
                "Reflinks also require the source and destination to be on the "
                "SAME filesystem. Use 'copy' or 'move' instead."
            )
        elif exc.errno == errno.EXDEV:
            msg = (
                "Cannot create a hard link or symlink across different filesystems. "
                "Use 'copy' or 'move' instead."
            )
        elif exc.errno == errno.EACCES:
            msg = f"Permission denied: {exc.filename}"
        elif exc.errno == errno.ENOSPC:
            msg = "No space left on the target device."
        elif exc.errno == errno.ENAMETOOLONG:
            # build_new_path truncates, so reaching this means the name came
            # from somewhere else (a hand-edited operation, a shorter limit on
            # an exotic mount) — say what is wrong instead of "[Errno 36]".
            msg = ("The generated name is longer than the filesystem allows "
                   "(255 bytes). Shorten the template or the manual name.")
        else:
            msg = str(exc)
        return RenameResult(
            original=source,
            destination=destination,
            action=action,
            success=False,
            error=msg,
        )
    except Exception as exc:
        _restore_parked(parked, destination)
        return RenameResult(
            original=source,
            destination=destination,
            action=action,
            success=False,
            error=str(exc),
        )


# A reflink can take a moment on a very large file the first time metadata is
# touched, but it never copies data — anything beyond this is a hung process,
# not slow hardware.
REFLINK_TIMEOUT_SECONDS = 60


def _reflink_copy(source: Path, destination: Path) -> None:
    """Clone `source` to `destination` share-on-write, or raise.

    Uses `cp --reflink=always` rather than a raw FICLONE ioctl: coreutils ships
    on every target this app builds for, and the ioctl number is encoded
    per-architecture, which is not something to hardcode for a filesystem
    feature that must either work exactly or fail loudly.

    "=always", never "=auto": auto silently falls back to a FULL byte copy, so
    a user who picked this action to save 40 GB would silently spend it. Failing
    with an actionable message is the honest behaviour.
    """
    binary = shutil.which("cp")
    if binary is None:
        raise OSError(errno.ENOENT,
                      "Reflink copy needs the 'cp' command (coreutils), which is "
                      "not on this system's PATH. Use 'copy' instead.")
    try:
        result = subprocess.run(
            [binary, "--reflink=always", "--preserve=mode,timestamps", "--",
             str(source), str(destination)],
            capture_output=True, text=True, timeout=REFLINK_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        raise OSError(errno.ETIMEDOUT,
                      f"Reflink copy timed out after {REFLINK_TIMEOUT_SECONDS}s") from None
    if result.returncode != 0:
        # EOPNOTSUPP routes into the errno chain above, which explains which
        # filesystems support this and what to use instead.
        raise OSError(errno.EOPNOTSUPP,
                      result.stderr.strip() or "reflink not supported here")


def _create_symlink(source: Path, link_path: Path) -> None:
    """Create a symlink at *link_path* pointing to *source*.

    Prefers a relative target when both paths share a filesystem; falls back to
    an absolute target when ``os.path.relpath`` raises (e.g. on different
    Windows drives).  Propagates ``OSError`` so callers can handle errno-based
    failures (e.g. EOPNOTSUPP on SMB mounts).
    """
    try:
        rel = os.path.relpath(source, link_path.parent)
        os.symlink(rel, str(link_path))
    except ValueError:
        # Different drive roots on Windows — fall back to absolute path
        os.symlink(str(source.resolve()), str(link_path))
