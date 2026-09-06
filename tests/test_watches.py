"""Per-rule watch intent — the F16 seam.

A rule could not say "movies only", "don't recurse", or "be surer than that
before touching my library", so one rule for ~/Downloads had to mean
"everything, everywhere, at the global threshold". Defaults here must
reproduce exactly the old behaviour: this is an unattended, destructive path,
and a config typo must never silently widen it.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.watches import (   # noqa: E402
    ALLOWED_MEDIA_TYPES, MAX_WATCHES, _clean, load_watches, save_watches,
)

BASE = {"folder": "/x", "template": "{n}", "datasource": "tmdb", "action": "move"}


def clean(**overrides):
    return _clean({**BASE, **overrides}, check_fs=False)


# ── defaults reproduce the old behaviour ─────────────────────────────────

def test_a_rule_without_the_new_fields_behaves_as_before():
    rule = clean()
    assert rule["recursive"] is True
    assert rule["include_extras"] is False
    assert rule["min_confidence"] is None      # follow the global gate
    assert rule["media_types"] is None         # every type


def test_every_field_round_trips():
    rule = clean(recursive=False, datasource="tvmaze", min_confidence=0.9,
                 media_types=["movie", "bogus"], include_extras=True)
    assert rule["recursive"] is False
    assert rule["datasource"] == "tvmaze"
    assert rule["min_confidence"] == 0.9
    assert rule["media_types"] == ["movie"]    # unknown type dropped
    assert rule["include_extras"] is True


# ── the confidence floor is the unattended-safety gate ───────────────────

@pytest.mark.parametrize("value, expected", [
    (0.9, 0.9), ("0.75", 0.75), (0, 0.0), (1, 1.0),
    (2.5, 1.0), (-1, 0.0),                     # clamped, not rejected
])
def test_confidence_is_clamped_into_range(value, expected):
    assert clean(min_confidence=value)["min_confidence"] == expected


@pytest.mark.parametrize("value", ["nonsense", None, "", [], {}])
def test_an_unparseable_confidence_falls_back_to_the_global_gate(value):
    """Never 0.0: a typo must not turn a rule into "rename anything you
    matched, at any confidence" on an unattended path."""
    assert clean(min_confidence=value)["min_confidence"] is None


# ── media types ──────────────────────────────────────────────────────────

def test_all_known_types_are_accepted():
    assert clean(media_types=list(ALLOWED_MEDIA_TYPES))["media_types"] == list(ALLOWED_MEDIA_TYPES)


@pytest.mark.parametrize("value", [[], ["bogus"], None, "movie"])
def test_an_empty_or_unusable_selection_means_every_type(value):
    """A rule that matches nothing is a broken rule, not an intent."""
    assert clean(media_types=value)["media_types"] is None


# ── the existing contract is untouched ───────────────────────────────────

@pytest.mark.parametrize("bad", [
    {"folder": ""}, {"datasource": "netflix"}, {"action": "delete"},
    {"template": ""}, {"template": "x" * 501},
])
def test_an_invalid_rule_is_still_refused(bad):
    assert clean(**bad) is None


def test_the_file_survives_a_round_trip(tmp_path, monkeypatch):
    monkeypatch.setenv("CINESORT_DATA_DIR", str(tmp_path))
    folder = tmp_path / "watched"
    folder.mkdir()

    saved = save_watches([{**BASE, "folder": str(folder), "recursive": False,
                           "min_confidence": 0.95, "media_types": ["movie"]}])
    assert saved[0]["recursive"] is False

    loaded = load_watches()
    assert loaded[0]["min_confidence"] == 0.95
    assert loaded[0]["media_types"] == ["movie"]
    assert loaded[0]["recursive"] is False


def test_a_rule_saved_before_this_feature_still_loads(tmp_path, monkeypatch):
    """Forward compatibility both ways: the file on disk has no new keys."""
    monkeypatch.setenv("CINESORT_DATA_DIR", str(tmp_path))
    config = tmp_path / "config"
    config.mkdir()
    (config / "watches.json").write_text(
        '[{"folder": "/old", "template": "{n}", "datasource": "tmdb",'
        ' "action": "move", "output_dir": "", "enabled": true}]', encoding="utf-8")

    rule = load_watches()[0]
    assert rule["recursive"] is True and rule["min_confidence"] is None


def test_the_rule_cap_still_holds(tmp_path, monkeypatch):
    monkeypatch.setenv("CINESORT_DATA_DIR", str(tmp_path))
    folder = tmp_path / "w"
    folder.mkdir()
    with pytest.raises(ValueError):
        save_watches([{**BASE, "folder": str(folder)}] * (MAX_WATCHES + 1))
