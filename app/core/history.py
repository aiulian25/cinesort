"""
Rename history tracking system for undo/redo operations.
Stores all rename operations in a JSON file.
"""

import errno
import json
import os
import shutil
from pathlib import Path
from datetime import datetime
from typing import List, Optional
from dataclasses import dataclass, asdict


@dataclass
class HistoryEntry:
    """A single rename operation."""
    id: str  # Unique ID for this operation
    timestamp: str  # ISO format datetime
    action: str  # "move", "copy", or "test"
    original: str  # Original file path
    destination: str  # New file path
    success: bool  # Whether the operation succeeded
    error: Optional[str] = None  # Error message if failed
    # One Rename click = one batch; lets the UI group entries and offer
    # "Undo all". Default None keeps pre-upgrade JSON loading unchanged.
    batch_id: Optional[str] = None


class RenameHistory:
    """Manages rename history with undo capability."""
    
    def __init__(self, history_file: Path = Path.home() / ".renamer_history.json"):
        self.history_file = history_file
        self._ensure_file()
    
    def _ensure_file(self):
        """Create the history file if it doesn't exist.

        One-time migration: when the configured location is empty but the
        legacy per-user file exists (pre-CINESORT_DATA_DIR installs), copy it
        over so no undo history is lost. No-op for everyone else.
        """
        if self.history_file.exists():
            return
        legacy = Path.home() / ".renamer_history.json"
        try:
            self.history_file.parent.mkdir(parents=True, exist_ok=True)
            if legacy.exists() and legacy != self.history_file:
                shutil.copy2(legacy, self.history_file)
                return
        except OSError:
            pass  # fall through to creating an empty file
        try:
            self.history_file.write_text("[]")
        except OSError:
            pass  # unwritable location — _load() degrades to empty history
    
    def _load(self) -> List[HistoryEntry]:
        """Load all history entries."""
        try:
            data = json.loads(self.history_file.read_text())
            return [HistoryEntry(**entry) for entry in data]
        except Exception:
            return []
    
    def _save(self, entries: List[HistoryEntry]):
        """Save all history entries."""
        data = [asdict(entry) for entry in entries]
        self.history_file.write_text(json.dumps(data, indent=2))
    
    def add_batch(self, operations: List[HistoryEntry]):
        """Add a batch of rename operations to history."""
        entries = self._load()
        entries.extend(operations)
        # Keep only last 1000 entries to prevent file growth
        entries = entries[-1000:]
        self._save(entries)
    
    def get_recent(self, limit: int = 50) -> List[HistoryEntry]:
        """Get recent rename operations."""
        entries = self._load()
        return entries[-limit:][::-1]  # Most recent first
    
    def _undo_entry(self, entries: List["HistoryEntry"], op: "HistoryEntry") -> tuple[bool, str]:
        """Guards + filesystem work for undoing ONE entry — action-aware.

        move / rename : move the file back (EXDEV-safe: falls back to
                        shutil.move when the reverse rename crosses devices,
                        matching the forward direction's behavior).
        keeplink      : remove the leftover symlink at the original path,
                        then move the file back.
        copy / hardlink / symlink : the original was never touched — undo
                        removes the created destination. For copy/hardlink the
                        original must still exist (deleting the destination
                        otherwise destroys the only copy of the data); a
                        symlink is just a pointer, so it is removed even when
                        dangling.
        test / undo   : never undoable.

        On success an "undo" record is APPENDED to *entries* but NOT saved —
        undo() persists once per call, undo_batch() once per batch.
        """
        if not op.success:
            return False, "Cannot undo failed operation"

        if op.action in ("test", "undo"):
            return False, "Cannot undo test/dry-run or undo operations"

        def record():
            entries.append(HistoryEntry(
                id=f"undo-{op.id}",
                timestamp=datetime.now().isoformat(),
                action="undo",
                original=op.destination,
                destination=op.original,
                success=True,
                batch_id=op.batch_id,
            ))

        dest = Path(op.destination)
        orig = Path(op.original)

        # ── copy / hardlink / symlink: undo = delete the created destination ──
        if op.action in ("copy", "hardlink", "symlink"):
            # is_symlink() first: a dangling symlink fails exists().
            if not (dest.is_symlink() or dest.exists()):
                return False, f"Destination no longer exists: {dest.name}"
            # Deleting a copy/hardlink when the original is gone would destroy
            # the only remaining copy of the data. A symlink holds no data, so
            # it is safe to remove even when its target has been deleted.
            if op.action != "symlink" and not orig.exists():
                return False, "Original file is gone; refusing to delete the only copy"
            try:
                dest.unlink()
            except OSError as e:
                return False, f"Undo failed: {e}"
            record()
            return True, f"Reverted: removed {dest.name} (original kept)"

        # ── move / rename / keeplink: move the file back ──────────────────────
        if not dest.exists():
            return False, f"Destination file no longer exists: {dest.name}"

        # keeplink left a symlink at the original path — remove it so the real
        # file can move back in.
        if op.action == "keeplink" and orig.is_symlink():
            try:
                orig.unlink()
            except OSError as e:
                return False, f"Undo failed removing leftover link: {e}"

        if orig.exists() or orig.is_symlink():
            return False, f"Original path already exists: {orig.name}"

        try:
            # Ensure parent directory exists
            orig.parent.mkdir(parents=True, exist_ok=True)
            try:
                dest.rename(orig)
            except OSError as e:
                if e.errno == errno.EXDEV:
                    # Reverse move crosses filesystems (forward direction used
                    # shutil.move, which handles this; mirror it on the way back).
                    shutil.move(str(dest), str(orig))
                else:
                    raise

            record()
            return True, f"Reverted: {dest.name} → {orig.name}"
        except Exception as e:
            return False, f"Undo failed: {str(e)}"

    def undo(self, operation_id: str) -> tuple[bool, str]:
        """Undo a single rename operation. Returns (success, message)."""
        entries = self._load()
        op = next((e for e in entries if e.id == operation_id), None)
        if not op:
            return False, "Operation not found in history"
        ok, msg = self._undo_entry(entries, op)
        if ok:
            self._save(entries)
        return ok, msg

    def undo_batch(self, batch_id: str) -> List[dict]:
        """Undo every undoable entry of a batch, in REVERSE insertion order
        (later operations may depend on earlier ones — e.g. files moved into
        a folder created by an earlier op). Persists once at the end.

        Returns [] when the batch id is unknown/has nothing undoable, else a
        per-entry list of {"id", "success", "message"}.
        """
        entries = self._load()
        ops = [
            e for e in entries
            if e.batch_id == batch_id and e.success and e.action not in ("test", "undo")
        ]
        if not ops:
            return []
        results = []
        changed = False
        for op in reversed(ops):
            ok, msg = self._undo_entry(entries, op)
            changed = changed or ok
            results.append({"id": op.id, "success": ok, "message": msg})
        if changed:
            self._save(entries)
        return results
    
    def clear_history(self):
        """Clear all history."""
        self._save([])


# Global instance.
# CINESORT_DATA_DIR (set to /data by the Docker image — a persistent volume)
# wins so history survives container recreation; unset (deb/AppImage/dev) keeps
# the per-user home location. Deployment-layer knob, single shared code path.
_dd = os.environ.get("CINESORT_DATA_DIR")
history = RenameHistory(Path(_dd) / "history.json") if _dd else RenameHistory()
