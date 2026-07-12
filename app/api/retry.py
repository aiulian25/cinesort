"""Shared single-retry helper for provider requests.

Only two failure classes are transient enough to deserve a retry:

  - HTTP 429 (rate limited): wait for the provider's ``Retry-After`` when it
    sends one (capped, so a broken/hostile header can never stall a match
    run), else a short fixed backoff.
  - ``httpx.TimeoutException``: one network blip; same fixed backoff.

Everything else — 401 revoked key, 404, 5xx, DNS failure — re-raises
immediately into the existing ``_sanitize_error`` paths: retrying those would
only delay the honest error the user needs to see.

MusicBrainz is deliberately NOT routed through this helper: its client
already throttles itself to 1 req/s and MusicBrainz policy forbids
aggressive automated retries.
"""

import asyncio
from typing import Optional

import httpx

DEFAULT_BACKOFF = 2.0   # seconds, for timeouts and 429s without Retry-After
MAX_RETRY_AFTER = 5.0   # honor Retry-After only up to this cap


def _retry_delay(exc: Exception) -> Optional[float]:
    """Seconds to wait before retrying `exc`, or None when it isn't retryable."""
    if isinstance(exc, httpx.TimeoutException):
        return DEFAULT_BACKOFF
    if isinstance(exc, httpx.HTTPStatusError) and exc.response is not None \
            and exc.response.status_code == 429:
        try:
            return max(0.0, min(float(exc.response.headers.get("Retry-After")), MAX_RETRY_AFTER))
        except (TypeError, ValueError):
            return DEFAULT_BACKOFF
    return None


async def with_retry(coro_factory, *, retries: int = 1):
    """Await ``coro_factory()``; on a retryable failure (429 / timeout) wait
    and try again, up to `retries` extra attempts.

    ``coro_factory`` must be a zero-argument callable returning a FRESH
    coroutine on each call (a coroutine object cannot be awaited twice) —
    pass ``lambda: client.search(q)``, never ``client.search(q)`` itself.
    """
    attempt = 0
    while True:
        try:
            return await coro_factory()
        except Exception as exc:
            delay = _retry_delay(exc)
            if delay is None or attempt >= retries:
                raise
            attempt += 1
            await asyncio.sleep(delay)
