"""Shared UI preferences — the F15 seam.

The Docker image is the recommended NAS deployment, so one instance faces many
browsers: presets built on the desktop were invisible on the laptop, and a
preset edited in one browser diverged from the watch rule that copied it.

These values arrive from a browser and are written to a file the server owns,
so the interesting cases are the bounds — an unbounded template is a
disk-filler, and a save from one client must never wipe another's work.
"""

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.main as main                                     # noqa: E402
from app.core.prefs import (                                 # noqa: E402
    MAX_CUSTOM_PRESETS, MAX_PRESET_LABEL, MAX_TEMPLATE,
    load_prefs, prefs_file, save_prefs,
)


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("CINESORT_DATA_DIR", str(tmp_path))


@pytest.fixture
def client():
    return TestClient(main.app)


# ── storage ──────────────────────────────────────────────────────────────

def test_a_missing_file_is_no_prefs_not_a_crash():
    assert load_prefs() == {}


def test_it_lives_beside_the_other_config(tmp_path):
    assert prefs_file() == tmp_path / "config" / "prefs.json"


def test_a_malformed_file_degrades_to_no_prefs():
    prefs_file().parent.mkdir(parents=True, exist_ok=True)
    prefs_file().write_text("{ not json", encoding="utf-8")
    assert load_prefs() == {}


def test_a_save_merges_rather_than_replaces():
    """One browser saving its template must not wipe the presets another
    browser is about to read."""
    save_prefs({"custom_presets": [{"label": "Mine", "template": "{n}"}]})
    merged = save_prefs({"template": "{n} ({y})"})

    assert merged["template"] == "{n} ({y})"
    assert merged["custom_presets"] == [{"label": "Mine", "template": "{n}"}]


# ── bounds ───────────────────────────────────────────────────────────────

def test_too_many_presets_are_refused():
    presets = [{"label": f"p{i}", "template": "{n}"} for i in range(MAX_CUSTOM_PRESETS + 1)]
    with pytest.raises(ValueError):
        save_prefs({"custom_presets": presets})


@pytest.mark.parametrize("preset", [
    {"label": "x" * (MAX_PRESET_LABEL + 1), "template": "{n}"},
    {"label": "ok", "template": "x" * (MAX_TEMPLATE + 1)},
    {"label": "   ", "template": "{n}"},
    {"label": "ok", "template": ""},
    {"label": 5, "template": "{n}"},
    "not a dict",
])
def test_an_unusable_preset_is_dropped_not_stored(preset):
    assert save_prefs({"custom_presets": [preset]})["custom_presets"] == []


@pytest.mark.parametrize("field, value", [
    ("datasource", "netflix"),
    ("template", "x" * (MAX_TEMPLATE + 1)),
    ("subfolders", "yes"),
])
def test_an_unusable_value_is_dropped_and_the_rest_survives(field, value):
    saved = save_prefs({field: value, "action": "move"})
    assert field not in saved
    assert saved["action"] == "move"


# ── the API ──────────────────────────────────────────────────────────────

def test_the_endpoint_round_trips(client):
    assert client.put("/api/prefs", json={"template": "{n} ({y})"}).status_code == 200
    assert client.get("/api/prefs").json()["template"] == "{n} ({y})"


def test_a_thirteenth_preset_is_rejected_by_the_api(client):
    presets = [{"label": f"p{i}", "template": "{n}"} for i in range(MAX_CUSTOM_PRESETS + 1)]
    assert client.put("/api/prefs", json={"custom_presets": presets}).status_code == 422


def test_a_partial_update_leaves_everything_else_alone(client):
    client.put("/api/prefs", json={"template": "{n}", "action": "copy",
                                   "custom_presets": [{"label": "A", "template": "{n}"}]})
    client.put("/api/prefs", json={"action": "move"})

    prefs = client.get("/api/prefs").json()
    assert prefs["action"] == "move"
    assert prefs["template"] == "{n}"
    assert prefs["custom_presets"] == [{"label": "A", "template": "{n}"}]


def test_the_file_on_disk_is_readable_json(client, tmp_path):
    client.put("/api/prefs", json={"template": "{n} ({y})"})
    stored = json.loads((tmp_path / "config" / "prefs.json").read_text(encoding="utf-8"))
    assert stored["template"] == "{n} ({y})"


def test_device_local_preferences_are_not_stored_server_side(client):
    """The theme and the last-scanned path describe the device you are sitting
    at; syncing them would fight the user across machines."""
    client.put("/api/prefs", json={"template": "{n}"})
    stored = client.get("/api/prefs").json()
    assert "theme" not in stored and "scanPath" not in stored
