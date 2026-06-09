#!/bin/bash
set -e

# Fix venv python symlinks to point to python3.12.
# The venv was built against python3.12 but /usr/bin/python3 may point to a
# newer version that cannot find the bundled site-packages.
VENV=/opt/CineSort/resources/venv/bin
if [ -d "$VENV" ] && [ -x /usr/bin/python3.12 ]; then
  ln -sf /usr/bin/python3.12 "$VENV/python3"
  ln -sf /usr/bin/python3.12 "$VENV/python3.12"
fi

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
