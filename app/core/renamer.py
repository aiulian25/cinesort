"""
File rename actions — ported from FileBot's StandardRenameAction enum.
Supports move, copy, hardlink, symlink, and dry-run.
"""

import errno
import os
import shutil
from enum import Enum
from pathlib import Path
from dataclasses import dataclass
from typing import Optional


class RenameAction(str, Enum):
    RENAME = "rename"    # in-place: atomic kernel rename, same directory, no folder creation
    MOVE = "move"
    COPY = "copy"
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


def execute_rename(
    source: Path,
    destination: Path,
    action: RenameAction = RenameAction.MOVE,
) -> RenameResult:
    """Execute a rename operation."""

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
        )

    except OSError as exc:
        if exc.errno == errno.EOPNOTSUPP:
            msg = (
                "The target filesystem does not support symbolic links "
                "(e.g. SMB/CIFS, FAT32, or exFAT). "
                "Use 'copy' or 'move' instead."
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
        return RenameResult(
            original=source,
            destination=destination,
            action=action,
            success=False,
            error=str(exc),
        )


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
