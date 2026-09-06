"""Runtime tuning through Settings — the F14 seam.

These four knobs gate an unattended, destructive path (watch folders rename on
their own), so the interesting cases are the ones that could WIDEN a gate: a
blank field, an inverted pair, an out-of-range number, a hand-edited config
file. None of them may quietly lower the bar.
"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.main as main                              # noqa: E402
from app.core.cache import provider_cache            # noqa: E402
from app.core.config import _validate_for            # noqa: E402


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    """Never touch the developer's ~/.config/cinesort, and start from a clean
    environment so one test's threshold cannot leak into the next."""
    monkeypatch.setenv("CINESORT_DATA_DIR", str(tmp_path))
    for key in main.TUNING_KEYS:
        monkeypatch.delenv(key, raising=False)
    original_ttl = provider_cache.ttl
    yield
    provider_cache.ttl = original_ttl


@pytest.fixture
def client():
    return TestClient(main.app)


# ── validation ───────────────────────────────────────────────────────────

def test_defaults_are_reported_when_nothing_is_set(client):
    settings = client.get("/api/settings").json()
    assert settings["low_confidence"] == main.DEFAULT_LOW_CONFIDENCE
    assert settings["review_confidence"] == main.DEFAULT_REVIEW_CONFIDENCE
    assert settings["watch_interval"] == 60
    assert settings["cache_ttl"] == provider_cache.ttl


def test_an_inverted_threshold_pair_is_refused(client):
    """Inverted, every match is both "weak" and "auto-renameable" — the gate
    reads as broken rather than misconfigured."""
    assert client.post("/api/settings",
                       json={"low_confidence": 0.8, "review_confidence": 0.6}).status_code == 422


@pytest.mark.parametrize("payload", [
    {"low_confidence": 1.5}, {"review_confidence": -0.1},
    {"watch_interval": 5}, {"cache_ttl": -1},
])
def test_out_of_range_values_are_refused(client, payload):
    assert client.post("/api/settings", json=payload).status_code == 422


def test_a_valid_pair_is_saved_and_takes_effect_immediately(client):
    assert client.post("/api/settings",
                       json={"low_confidence": 0.4, "review_confidence": 0.9}).status_code == 200

    assert main._thresholds() == (0.4, 0.9)
    settings = client.get("/api/settings").json()
    assert (settings["low_confidence"], settings["review_confidence"]) == (0.4, 0.9)


def test_the_value_is_persisted_to_the_config_file(client, tmp_path):
    client.post("/api/settings", json={"review_confidence": 0.95})
    keys_env = tmp_path / "config" / "keys.env"

    assert "CINESORT_REVIEW_CONFIDENCE=0.95" in keys_env.read_text(encoding="utf-8")
    assert oct(keys_env.stat().st_mode)[-3:] == "600"


# ── a blank field must never reset a gate ────────────────────────────────

def test_saving_only_an_api_key_leaves_the_thresholds_alone(client):
    client.post("/api/settings", json={"review_confidence": 0.95})
    client.post("/api/settings", json={"tmdb_language": "de"})
    assert main._thresholds()[1] == 0.95


def test_omitting_a_field_is_not_the_same_as_zero(client):
    client.post("/api/settings", json={"watch_interval": 300})
    client.post("/api/settings", json={"review_confidence": 0.8})
    assert main._watch_interval() == 300


# ── cache TTL ────────────────────────────────────────────────────────────

def test_changing_the_ttl_applies_and_drops_stale_entries(client):
    provider_cache.set(("probe",), "value")
    assert provider_cache.get(("probe",)) == "value"

    client.post("/api/settings", json={"cache_ttl": 120})

    assert provider_cache.ttl == 120
    # Entries stored under the OLD ttl keep the old expiry, which would make a
    # shortened window a lie.
    assert provider_cache.get(("probe",)) is None


# ── the config layer is its own gate ─────────────────────────────────────

@pytest.mark.parametrize("value", ["abc", "", "1.5", "-1", "0.5\nTMDB_API_KEY=stolen"])
def test_the_config_file_refuses_a_bad_threshold(value):
    """keys.env is hand-editable and shares a file with API keys: a value that
    smuggles a newline would inject a second key=value line."""
    assert _validate_for("CINESORT_REVIEW_CONFIDENCE", value) is False


@pytest.mark.parametrize("key, value", [
    ("CINESORT_REVIEW_CONFIDENCE", "0.95"), ("CINESORT_LOW_CONFIDENCE", "0"),
    ("CINESORT_WATCH_INTERVAL", "60"), ("CINESORT_CACHE_TTL", "0"),
])
def test_the_config_file_accepts_sane_values(key, value):
    assert _validate_for(key, value) is True


# ── environment precedence is reported, not hidden ───────────────────────

def test_an_env_managed_knob_is_flagged_to_the_ui(client, monkeypatch):
    """load_config never overwrites an existing env var, so a Settings edit to
    one is saved but never takes effect after a restart. The UI is told rather
    than left to present a field that silently does nothing.

    The flag is captured at import — once load_config has run, a value from the
    environment and one from keys.env are indistinguishable in os.environ.
    """
    monkeypatch.setattr(main, "_ENV_SUPPLIED_TUNING",
                        frozenset({"CINESORT_REVIEW_CONFIDENCE"}))
    managed = client.get("/api/settings").json()["tuning_managed_in_env"]

    assert managed["review_confidence"] is True
    assert managed["watch_interval"] is False


def test_an_environment_value_still_wins_over_the_saved_one(client, monkeypatch):
    """Documented precedence, unchanged: "Existing env vars (e.g. Docker
    compose) always win" (config.load_config). A deployment's admin is not
    overridden by a click in the UI."""
    client.post("/api/settings", json={"review_confidence": 0.95})
    monkeypatch.setenv("CINESORT_REVIEW_CONFIDENCE", "0.7")
    assert main._thresholds()[1] == 0.7


# ── F17: the tray preference the Electron shell reads ────────────────────

def test_the_tray_preference_round_trips(client, tmp_path):
    """One value, owned by the backend, so the shell and the page can never
    disagree about whether tray mode is on."""
    assert client.get("/api/settings").json()["keep_in_tray"] is False

    assert client.post("/api/settings", json={"keep_in_tray": True}).status_code == 200
    assert client.get("/api/settings").json()["keep_in_tray"] is True
    assert "CINESORT_TRAY=1" in (tmp_path / "config" / "keys.env").read_text(encoding="utf-8")

    client.post("/api/settings", json={"keep_in_tray": False})
    assert client.get("/api/settings").json()["keep_in_tray"] is False


def test_saving_something_else_leaves_the_tray_setting_alone(client):
    client.post("/api/settings", json={"keep_in_tray": True})
    client.post("/api/settings", json={"review_confidence": 0.8})
    assert client.get("/api/settings").json()["keep_in_tray"] is True


@pytest.mark.parametrize("value", ["yes", "2", "", "true"])
def test_the_config_file_only_accepts_a_boolean_flag(value):
    assert _validate_for("CINESORT_TRAY", value) is False


# ── the runtime watch pause the tray toggles ─────────────────────────────

def test_pausing_is_runtime_only_and_never_rewrites_the_rules(client, monkeypatch):
    """The tray's "Pause watching" must not express itself by disabling every
    saved rule — that state would outlive the session with no memory of having
    chosen it."""
    monkeypatch.setattr(main, "_watch_paused", False)

    assert client.post("/api/watch-pause", json={"paused": True}).json()["paused"] is True
    assert main._watch_paused is True
    assert client.get("/api/watches").json()["paused"] is True

    client.post("/api/watch-pause", json={"paused": False})
    assert main._watch_paused is False


def test_a_paused_loop_skips_its_cycle(monkeypatch):
    """The pause is honoured where it matters — before any rule is examined."""
    import asyncio

    monkeypatch.setattr(main, "_watch_paused", True)
    monkeypatch.setattr(main, "_watch_interval", lambda: 0.01)
    monkeypatch.setattr(main, "load_watches",
                        lambda: (_ for _ in ()).throw(AssertionError("rules were read")))

    async def run_briefly():
        task = asyncio.create_task(main._watch_loop())
        await asyncio.sleep(0.05)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(run_briefly())   # no AssertionError → the cycle was skipped
