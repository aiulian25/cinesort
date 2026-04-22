"""
Rename history tracking system for undo/redo operations.
Stores all rename operations in a JSON file.
"""

import json
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


class RenameHistory:
    """Manages rename history with undo capability."""
    
    def __init__(self, history_file: Path = Path.home() / ".renamer_history.json"):
        self.history_file = history_file
        self._ensure_file()
    
    def _ensure_file(self):
        """Create history file if it doesn't exist."""
        if not self.history_file.exists():
            self.history_file.write_text("[]")
    
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
    
    def undo(self, operation_id: str) -> tuple[bool, str]:
        """Undo a specific rename operation.
        
        Returns:
            (success, message) tuple
        """
        entries = self._load()
        
        # Find the operation
        op = None
        for entry in entries:
            if entry.id == operation_id:
                op = entry
                break
        
        if not op:
            return False, "Operation not found in history"
        
        if not op.success:
            return False, "Cannot undo failed operation"
        
        if op.action == "test":
            return False, "Cannot undo test/dry-run operation"
        
        # Check if files still exist at expected locations
        dest = Path(op.destination)
        if not dest.exists():
            return False, f"Destination file no longer exists: {dest.name}"
        
        orig = Path(op.original)
        if orig.exists():
            return False, f"Original path already exists: {orig.name}"
        
        # Perform the undo (move file back)
        try:
            # Ensure parent directory exists
            orig.parent.mkdir(parents=True, exist_ok=True)
            dest.rename(orig)
            
            # Record the undo operation
            undo_entry = HistoryEntry(
                id=f"undo-{operation_id}",
                timestamp=datetime.now().isoformat(),
                action="undo",
                original=op.destination,
                destination=op.original,
                success=True,
            )
            entries.append(undo_entry)
            self._save(entries)
            
            return True, f"Reverted: {dest.name} → {orig.name}"
        except Exception as e:
            return False, f"Undo failed: {str(e)}"
    
    def clear_history(self):
        """Clear all history."""
        self._save([])


# Global instance
history = RenameHistory()
