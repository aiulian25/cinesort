"""Version consistency across the four release targets.

The number cannot live in one physical place: electron-builder reads
package.json before any Python exists, and the Docker image never contains
package.json (the Dockerfile copies app/ and requirements.txt only). So there
are two literals — app/__init__.py and package.json — plus the README badge,
and these tests are what keeps them equal.

Why it matters: the "update available" decision is made by the BACKEND
(_check_update compares the GitHub tag to app.version, app/main.py:2358), while
the desktop restart-to-finish prompt is made by ELECTRON (app.getVersion() from
package.json, electron/main.js:686). If the two literals drift, a deb/rpm user
is told an update is pending forever — and Docker, which has no Electron half,
never reproduces it.
"""

import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import __version__                        # noqa: E402
from app.api.musicbrainz import USER_AGENT         # noqa: E402

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def _read(name: str) -> str:
    path = ROOT / name
    assert path.is_file(), f"{name} missing from the checkout — cannot verify version consistency"
    return path.read_text(encoding="utf-8")


def test_version_is_semver():
    assert SEMVER.match(__version__), f"app.__version__ = {__version__!r}"


def test_package_json_matches():
    """electron-builder's version — drives app.getVersion() on deb/rpm/AppImage."""
    pkg = json.loads(_read("package.json"))["version"]
    assert pkg == __version__, (
        f"package.json says {pkg}, app/__init__.py says {__version__}. "
        "Desktop builds would report a different version than their own backend."
    )


def test_fastapi_reports_the_same_version():
    """/api/version — the string every update check compares against."""
    import app.main as main
    assert main.app.version == __version__


def test_musicbrainz_user_agent_tracks_the_build():
    assert USER_AGENT == f"CineSort/{__version__} (https://github.com/aiulian25/cinesort)"


def test_readme_badge_matches():
    badge = re.search(r"version-([\d.]+)-", _read("README.md"))
    assert badge and badge.group(1) == __version__


def test_readme_install_commands_match():
    """The copy-paste install block names the artifact files by version."""
    readme = _read("README.md")
    named = set(re.findall(r"[Cc]ine[Ss]ort[_-](\d+\.\d+\.\d+)", readme))
    assert named == {__version__}, f"README install commands reference {sorted(named)}"


def test_no_second_version_literal_in_app_package():
    """The acceptance criterion `grep -rn <version> app/` — one hit, one file."""
    offenders = [
        str(py.relative_to(ROOT))
        for py in (ROOT / "app").rglob("*.py")
        if py.name != "__init__.py" and f'"{__version__}"' in py.read_text(encoding="utf-8")
    ]
    assert not offenders, f"version hardcoded again in: {offenders}"


@pytest.mark.parametrize("script", ["docker:build", "docker:release"])
def test_docker_scripts_pass_the_version(script):
    """Without the build arg the image label silently falls back to 'dev'."""
    scripts = json.loads(_read("package.json"))["scripts"]
    assert "--build-arg APP_VERSION=$npm_package_version" in scripts[script]


def test_dockerfile_label_comes_from_the_build_arg():
    dockerfile = _read("Dockerfile")
    assert 'LABEL version="${APP_VERSION}"' in dockerfile
    assert re.search(r"^ARG APP_VERSION=", dockerfile, re.M)
