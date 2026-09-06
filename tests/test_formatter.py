"""Path-building guards — the F7 seam.

The bug these exist for: a generated name longer than the filesystem allows
passed matching, passed the dry run *reporting success*, then failed the real
rename with a raw "[Errno 36] File name too long". The limit is in BYTES, so
character-based caps miss every non-Latin title.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.formatter import (   # noqa: E402
    KNOWN_TOKENS, MAX_NAME_BYTES, TEMPLATES, TOKENS, apply_template,
    build_new_path, truncate_component, unknown_tokens,
)

SOURCE = Path("/media/movies/source.mkv")


def components(path: Path, base: Path = Path("/media/movies")):
    """The parts build_new_path appended below the base directory."""
    return path.parts[len(base.parts):]


# ── The limit is bytes, and it is enforced on every component ─────────────

def test_long_title_truncates_every_component_and_keeps_the_extension():
    title = "A Very Long Movie Title That Nobody Would Ever Sensibly Use " * 6
    assert len(title.encode("utf-8")) > MAX_NAME_BYTES, "test input must exceed the limit"
    built = build_new_path(SOURCE, "{n} ({y})/{n} ({y})", {"n": title, "y": 2024})

    parts = components(built)
    assert len(parts) == 2, "template asked for a folder and a file"
    for part in parts:
        assert len(part.encode("utf-8")) <= MAX_NAME_BYTES, f"{part!r} exceeds the limit"
    assert built.suffix == ".mkv"


def test_cjk_title_never_splits_a_character():
    """200 CJK characters is ~600 bytes — the case a character cap misses."""
    title = "字幕付き映画のとても長いタイトル" * 15
    built = build_new_path(SOURCE, "{n}", {"n": title})

    name = built.name
    assert len(name.encode("utf-8")) <= MAX_NAME_BYTES
    assert built.suffix == ".mkv"
    # A mid-character cut would leave an undecodable tail; round-tripping proves
    # the slice landed on a character boundary.
    assert name.encode("utf-8").decode("utf-8") == name
    assert "�" not in name


def test_name_already_within_the_limit_is_untouched():
    exact = "a" * (MAX_NAME_BYTES - len(".mkv"))
    built = build_new_path(SOURCE, "{n}", {"n": exact})
    assert built.name == exact + ".mkv"
    assert len(built.name.encode("utf-8")) == MAX_NAME_BYTES


def test_pathological_extension_does_not_corrupt_the_name():
    """An extension longer than the budget makes `reserve` exceed it. Without
    the max(0, …) clamp, `raw[:budget]` becomes a NEGATIVE slice and silently
    chops bytes off the end of the title instead of truncating to nothing —
    e.g. "Normal Title Padded…" would come back as "Normal Title Padded To Be".
    """
    title = "Normal Title Padded Out To Be Long Enough"          # 41 bytes
    weird_source = Path("/media/movies/source." + "e" * 260)     # reserve > budget
    built = build_new_path(weird_source, "{n}", {"n": title})

    stem = built.name[: -len(weird_source.suffix)]
    assert stem == "", f"negative slice leaked a chopped title: {stem!r}"
    assert stem not in (title[:25], title[:30]), "must not be a truncated fragment"


# ── truncate_component itself ─────────────────────────────────────────────

def test_truncate_component_reserves_room_for_a_suffix():
    name = "x" * 300
    reserved = truncate_component(name, reserve=len(".en.srt".encode("utf-8")))
    assert len(reserved.encode("utf-8")) + len(".en.srt") <= MAX_NAME_BYTES


def test_truncate_component_trims_a_trailing_dot_exposed_by_the_cut():
    name = "y" * (MAX_NAME_BYTES - 1) + "." + "z" * 10
    assert not truncate_component(name).endswith(".")


def test_truncate_component_is_a_noop_below_the_limit():
    assert truncate_component("short name") == "short name"


# ── Template behavior the rename path depends on ──────────────────────────

def test_empty_bindings_collapse_instead_of_leaving_brackets():
    out = apply_template("{n} ({y}) [{edition}]", {"n": "Movie", "y": 2024, "edition": ""})
    assert out == "Movie (2024)"


def test_empty_id_hint_does_not_leave_a_dangling_prefix():
    out = apply_template("{n} [imdbid-{imdbid}]", {"n": "Movie", "imdbid": ""})
    assert out == "Movie"


@pytest.mark.parametrize("alias, canonical", [
    ("{name}", "{n}"), ("{year}", "{y}"), ("{title}", "{t}"), ("{quality}", "{vf}"),
])
def test_friendly_aliases_resolve_to_the_same_output(alias, canonical):
    bindings = {"n": "Movie", "y": 2024, "t": "Episode", "vf": "1080p"}
    assert apply_template(alias, bindings) == apply_template(canonical, bindings)


# ── F3: the {partN} token collapses for single-file releases ──────────────

def test_part_token_renders_and_collapses():
    assert apply_template("{n} ({y}){partN}",
                          {"n": "Movie", "y": 2010, "partN": " - Part 2"}) == "Movie (2010) - Part 2"
    assert apply_template("{n} ({y}){partN}",
                          {"n": "Movie", "y": 2010, "partN": ""}) == "Movie (2010)"


def test_two_parts_of_one_film_get_distinct_paths():
    """The whole point: identical bindings apart from the part number must no
    longer produce identical destinations."""
    template = "{n} ({y})/{n} ({y}){partN}"
    first = apply_template(template, {"n": "Movie", "y": 2010, "partN": " - Part 1"})
    second = apply_template(template, {"n": "Movie", "y": 2010, "partN": " - Part 2"})
    assert first != second
    assert first == "Movie (2010)/Movie (2010) - Part 1"


# ── F21: the token table is the single source ────────────────────────────
#
# Three hand-maintained lists (formatter docstring, app.js, README) is how
# {e00} came to work but be undocumented, and {quality} to be documented in
# the UI and nowhere else.

FULL_BINDINGS = {
    "n": "Breaking Bad", "y": 2008, "s": 1, "e": 5, "e_end": 6, "t": "Pilot",
    "absolute": 42, "d": "2008-01-20", "source": "WEB-DL", "vf": "1080p",
    "group": "GROUP", "codec": "x265", "audio": "DTS-HD", "edition": "Extended",
    "part": 2, "partN": " - Part 2", "id": 1396, "tmdbid": 1396,
    "collection": "Iron Man Collection", "collectionN": "Iron Man Collection/",
    "imdbid": "tt0903747", "artist": "Radiohead", "album": "OK Computer",
    "track": "03",
}


@pytest.mark.parametrize("token", [t["name"] for t in TOKENS])
def test_every_documented_token_actually_renders(token):
    """A token in the table that binds to nothing is worse than an undocumented
    one: the palette invites the user to paste it and it silently vanishes."""
    assert apply_template(token, FULL_BINDINGS) != ""


@pytest.mark.parametrize("name, template", sorted(TEMPLATES.items()))
def test_shipped_templates_use_only_known_tokens(name, template):
    assert unknown_tokens(template) == []


def test_unknown_tokens_names_the_typo():
    assert unknown_tokens("{n} {episode}") == ["episode"]
    assert unknown_tokens("{n} ({y}){partN}") == []
    assert unknown_tokens("") == []


def test_the_table_has_no_duplicates_and_is_well_formed():
    names = [t["name"] for t in TOKENS]
    assert len(names) == len(set(names))
    assert len(KNOWN_TOKENS) == len(names)
    for token in TOKENS:
        assert token["name"].startswith("{") and token["name"].endswith("}")
        assert token["description"] and token["example"]
        assert token["kind"] in {"all", "series", "video", "movie", "music"}


def test_the_readme_table_is_in_sync_with_the_code():
    """tools/gen_token_table.py writes it; this fails the build if someone adds
    a token and forgets to re-run it — the drift this feature exists to end."""
    import subprocess
    root = Path(__file__).resolve().parent.parent
    generated = subprocess.run(
        [sys.executable, str(root / "tools" / "gen_token_table.py")],
        capture_output=True, text=True, cwd=str(root), check=True).stdout.strip()
    readme = (root / "README.md").read_text(encoding="utf-8")
    start = readme.index("<!-- tokens:start -->") + len("<!-- tokens:start -->")
    assert readme[start:readme.index("<!-- tokens:end -->")].strip() == generated


# ── F9: the {collection} folder level appears only for franchise films ────

def test_collection_nests_a_franchise_film_one_level_deeper():
    template = "{collectionN}{n} ({y})/{n} ({y})"
    assert apply_template(template, {"n": "Iron Man", "y": 2008,
                                     "collectionN": "Iron Man Collection/"}) == \
        "Iron Man Collection/Iron Man (2008)/Iron Man (2008)"


def test_a_standalone_film_gains_no_folder_level():
    """The same template must serve both — otherwise a library needs two."""
    template = "{collectionN}{n} ({y})/{n} ({y})"
    assert apply_template(template, {"n": "Inception", "y": 2010, "collectionN": ""}) == \
        "Inception (2010)/Inception (2010)"


def test_the_bare_collection_token_renders_the_name_only():
    assert apply_template("{collection}", {"collection": "James Bond Collection"}) == \
        "James Bond Collection"
    assert apply_template("{n} ({y}) [{collection}]",
                          {"n": "Inception", "y": 2010, "collection": ""}) == "Inception (2010)"
