#!/bin/bash
set -e

# ── Python venv repair ────────────────────────────────────────────────────────
# The venv bundled in the .deb was built on the CI/dev machine for a specific
# CPython minor version (e.g. 3.12).  On the target machine that exact version
# may not be installed, or the symlinks inside the venv may point to the wrong
# prefix.  This block:
#   1. Discovers the Python version the venv expects (from lib/pythonX.Y/).
#   2. Looks for that exact version on the system.
#   3. If found, rewrites the symlinks and pyvenv.cfg — no network access needed.
#   4. If NOT found, finds any Python 3.9+ and rebuilds the venv from the
#      bundled requirements.txt so the app works regardless of what Python
#      version is installed.

VENV=/opt/CineSort/resources/venv
REQ=/opt/CineSort/resources/requirements.txt

# --- helpers ------------------------------------------------------------------
find_venv_python_version() {
    # Read lib/pythonX.Y to discover what the venv was built for.
    local libdir="$VENV/lib"
    [ -d "$libdir" ] || return 1
    local entry
    entry=$(ls "$libdir" 2>/dev/null | grep -E '^python[0-9]+\.[0-9]+$' | head -1)
    [ -n "$entry" ] && echo "$entry" | sed 's/python//'
}

find_system_python() {
    # Try an explicit version first (highest first so we get the newest compatible).
    local want_ver="$1"   # e.g. "3.12" — may be empty
    local prefixes="/usr/bin /usr/local/bin"

    if [ -n "$want_ver" ]; then
        for pre in $prefixes; do
            local candidate="$pre/python$want_ver"
            [ -x "$candidate" ] && { echo "$candidate"; return 0; }
        done
    fi

    # Fall back to any Python 3.9+
    for minor in 13 12 11 10 9; do
        for pre in $prefixes; do
            local candidate3="$pre/python3.$minor"
            [ -x "$candidate3" ] && { echo "$candidate3"; return 0; }
        done
    done
    return 1
}

fix_venv_symlinks() {
    local py_path="$1"
    local py_ver="$2"   # e.g. "3.12"
    local bin="$VENV/bin"

    ln -sf "$py_path" "$bin/python3"
    local vlink="$bin/python$py_ver"
    ln -sf "$py_path" "$vlink"

    # Rewrite the home= line in pyvenv.cfg so the venv activates correctly.
    local cfg="$VENV/pyvenv.cfg"
    if [ -f "$cfg" ]; then
        local py_dir
        py_dir="$(dirname "$py_path")"
        sed -i "s|^home = .*|home = $py_dir|" "$cfg"
    fi
}

rebuild_venv() {
    local py_path="$1"
    echo "CineSort postinst: rebuilding venv with $py_path — this may take a moment..."
    "$py_path" -m venv --clear "$VENV"
    "$VENV/bin/pip" install --quiet -r "$REQ"
    echo "CineSort postinst: venv ready."
}

# --- main logic ---------------------------------------------------------------
if [ -d "$VENV" ]; then
    VENV_VER=$(find_venv_python_version || true)
    SYS_PY=$(find_system_python "$VENV_VER" || true)

    if [ -z "$SYS_PY" ]; then
        echo "WARNING: CineSort could not find Python 3.9+ on this system." >&2
        echo "         Install Python 3.9 or later and re-run: sudo dpkg --configure cinesort" >&2
    else
        SYS_MINOR="$("$SYS_PY" -c 'import sys; print(str(sys.version_info.major)+"."+str(sys.version_info.minor))')"

        if [ "$SYS_MINOR" = "$VENV_VER" ]; then
            # Exact match — just fix symlinks (fast, no network).
            echo "CineSort postinst: fixing venv symlinks for Python $SYS_MINOR..."
            fix_venv_symlinks "$SYS_PY" "$SYS_MINOR"
        else
            # Version mismatch — rebuild venv so C extensions match the system Python.
            rebuild_venv "$SYS_PY"
        fi
    fi
fi
# ─────────────────────────────────────────────────────────────────────────────

# ── Electron sandbox setup ────────────────────────────────────────────────────
# Preferred approach: make chrome-sandbox setuid root so the full Chromium
# sandbox works without --no-sandbox. This is safer than disabling the sandbox.
CHROME_SANDBOX=/opt/CineSort/chrome-sandbox
if [ -f "$CHROME_SANDBOX" ]; then
  chown root "$CHROME_SANDBOX" 2>/dev/null || true
  chmod 4755 "$CHROME_SANDBOX" 2>/dev/null || true
fi

# Belt-and-suspenders: also patch the desktop entry with --no-sandbox so that
# the app still works even if the chown/chmod above was skipped (e.g. non-root
# install). The sed uses a flexible pattern that survives electron-builder
# changing the Exec= format across versions.
DESKTOP=/usr/share/applications/cinesort.desktop
if [ -f "$DESKTOP" ]; then
  # Rewrite any Exec= line that contains the cinesort binary but lacks
  # --no-sandbox. Works regardless of whether %U or other args are present.
  if ! grep -q -- '--no-sandbox' "$DESKTOP"; then
    sed -i 's|^\(Exec=.*cinesort\)\(.*\)$|\1 --no-sandbox\2|' "$DESKTOP"
  fi
fi
# ─────────────────────────────────────────────────────────────────────────────

# Refresh icon cache and desktop database
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t /usr/share/icons/hicolor/ 2>/dev/null || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications/ 2>/dev/null || true
fi
