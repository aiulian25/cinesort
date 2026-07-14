"""In-memory TTL cache for provider responses.

Matching the same show across batches (or re-matching after a disambiguation
click) used to refetch every season from the provider each time. This cache
remembers successful provider responses for a short window so a second Match
on the same show costs zero HTTP requests — freshly-aired episodes still
appear once the entry expires.

Deliberate properties:

  - Memory-only. Nothing is written to /data or ~/.config, so there are no
    file-permission or persistence differences between Docker, deb, rpm and
    AppImage — and API-derived data never outlives the process.
  - Only SUCCESSFUL responses are stored (callers raise before ``set`` runs),
    so an error is always retried on the next attempt.
  - Monotonic clock — immune to wall-clock jumps (NTP, suspend/resume).
  - Bounded: max 256 entries, FIFO eviction. Provider payloads are small
    (episode lists, search results); the bound is a leak guard, not a tuning
    knob.
  - No locks: the app runs a single event loop and the match UI serializes
    runs (see the match_progress comment in main.py), and dict operations
    are atomic within one await-free step.

``CINESORT_CACHE_TTL`` (seconds) overrides the 15-minute default at process
start; ``0`` disables caching entirely. Deployment-layer, identical default
on every build target.
"""

import os
import time


def _ttl_env(default: float = 900.0) -> float:
    """TTL from CINESORT_CACHE_TTL, clamped to >= 0; garbage → default."""
    try:
        ttl = float(os.environ.get("CINESORT_CACHE_TTL", default))
    except (TypeError, ValueError):
        return default
    return max(0.0, ttl)


class TTLCache:
    def __init__(self, ttl: float = None, max_entries: int = 256):
        self.ttl = _ttl_env() if ttl is None else ttl
        self.max_entries = max_entries
        # key -> (expires_at, value); insertion order gives us FIFO eviction.
        self._entries = {}

    def get(self, key):
        """Return the cached value, or None on miss/expiry (providers never
        return None, so None is unambiguous)."""
        item = self._entries.get(key)
        if item is None:
            return None
        if time.monotonic() >= item[0]:
            del self._entries[key]
            return None
        return item[1]

    def set(self, key, value) -> None:
        if self.ttl <= 0:
            return
        if key in self._entries:
            del self._entries[key]           # re-insert at the back
        elif len(self._entries) >= self.max_entries:
            self._entries.pop(next(iter(self._entries)))   # FIFO: drop oldest
        self._entries[key] = (time.monotonic() + self.ttl, value)

    def clear(self) -> None:
        self._entries.clear()

    def __len__(self) -> int:
        return len(self._entries)


# Shared singleton for all provider responses, keyed (source, kind, *args).
provider_cache = TTLCache()


async def cached(key, coro_factory, cache: TTLCache = provider_cache):
    """Return the cached value for `key`, or await ``coro_factory()`` and
    store its result. Exceptions propagate without touching the cache."""
    hit = cache.get(key)
    if hit is not None:
        return hit
    value = await coro_factory()
    cache.set(key, value)
    return value
