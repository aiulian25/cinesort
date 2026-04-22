"""
File rename actions — ported from FileBot's StandardRenameAction enum.
Supports move, copy, hardlink, symlink, and dry-run.
"""

import os
import shutil
from enum import Enum
from pathlib import Path
from dataclasses import dataclass
from typing import Optional


class RenameAction(str, Enum):
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
        # Create destination directory
        destination.parent.mkdir(parents=True, exist_ok=True)

        # Handle conflict: if destination already exists
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
            # Use relative symlink when possible
            try:
                rel_path = os.path.relpath(source, destination.parent)
                os.symlink(rel_path, str(destination))
            except ValueError:
                os.symlink(str(source.resolve()), str(destination))

        elif action == RenameAction.KEEPLINK:
            shutil.move(str(source), str(destination))
            # Leave a symlink at the original location
            try:
                rel_path = os.path.relpath(destination, source.parent)
                os.symlink(rel_path, str(source))
            except ValueError:
                os.symlink(str(destination.resolve()), str(source))

        return RenameResult(
            original=source,
            destination=destination,
            action=action,
            success=True,
        )

    except Exception as exc:
        return RenameResult(
            original=source,
            destination=destination,
            action=action,
            success=False,
            error=str(exc),
        )
