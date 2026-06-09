#!/usr/bin/env bash
# CineSort AppImage installer
# Installs CineSort into your application launcher with full icon support.
# Run once after downloading; the AppImage auto-updates the entry on each launch.
#
# Usage:
#   chmod +x install-appimage.sh
#   ./install-appimage.sh [path/to/CineSort-*.AppImage]
#
# If no path is given, the script searches the current directory and ~/Downloads.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="CineSort"
ICON_NAME="cinesort"
DESKTOP_FILE="$HOME/.local/share/applications/${ICON_NAME}.desktop"
HICOLOR_BASE="$HOME/.local/share/icons/hicolor"

# ── Find the AppImage ─────────────────────────────────────────────────────────
find_appimage() {
    for dir in "$SCRIPT_DIR" "$SCRIPT_DIR/dist" "$HOME/Downloads"; do
        [[ -d "$dir" ]] || continue
        local found
        found=$(find "$dir" -maxdepth 1 -name "CineSort-*.AppImage" -type f 2>/dev/null | sort -V | tail -1)
        if [[ -n "$found" ]]; then
            echo "$found"
            return 0
        fi
    done
    return 1
}

if [[ $# -ge 1 ]]; then
    APPIMAGE="$(realpath "$1")"
else
    if ! APPIMAGE="$(find_appimage)"; then
        echo "ERROR: No CineSort AppImage found."
        echo "Usage: $0 path/to/CineSort-1.2.0.AppImage"
        exit 1
    fi
fi

if [[ ! -f "$APPIMAGE" ]]; then
    echo "ERROR: File not found: $APPIMAGE"
    exit 1
fi

chmod +x "$APPIMAGE"
echo "Installing: $APPIMAGE"

# ── Install icons from project build/icons (if available) ────────────────────
ICONS_DIR="$SCRIPT_DIR/build/icons"
if [[ -d "$ICONS_DIR" ]]; then
    for size in 16x16 24x24 32x32 48x48 64x64 96x96 128x128 256x256 512x512; do
        src="$ICONS_DIR/${size}.png"
        [[ -f "$src" ]] || continue
        dest_dir="$HICOLOR_BASE/${size}/apps"
        mkdir -p "$dest_dir"
        cp "$src" "$dest_dir/${ICON_NAME}.png"
    done
    echo "Icons installed to $HICOLOR_BASE"
fi

# Fallback: extract icon from the AppImage itself
if [[ ! -f "$HICOLOR_BASE/512x512/apps/${ICON_NAME}.png" ]]; then
    echo "Extracting icon from AppImage..."
    tmpdir=$(mktemp -d)
    trap 'rm -rf "$tmpdir"' EXIT
    APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGE" --appimage-extract "*.png" >/dev/null 2>&1 || true
    # electron-builder puts the app icon as cinesort.png in the AppImage root
    if [[ -f "squashfs-root/${ICON_NAME}.png" ]]; then
        dest_dir="$HICOLOR_BASE/512x512/apps"
        mkdir -p "$dest_dir"
        cp "squashfs-root/${ICON_NAME}.png" "$dest_dir/${ICON_NAME}.png"
        rm -rf squashfs-root
    fi
fi

# ── Write .desktop entry ──────────────────────────────────────────────────────
mkdir -p "$(dirname "$DESKTOP_FILE")"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=$APP_NAME
Comment=Professional media file organizer
Exec=env APPIMAGE_EXTRACT_AND_RUN=1 ${APPIMAGE} --no-sandbox %U
Icon=$ICON_NAME
Categories=AudioVideo;Video;Utility;
Terminal=false
StartupNotify=true
StartupWMClass=CineSort
EOF

chmod 644 "$DESKTOP_FILE"
echo "Desktop entry written: $DESKTOP_FILE"

# ── Refresh caches ────────────────────────────────────────────────────────────
if command -v gtk-update-icon-cache &>/dev/null; then
    gtk-update-icon-cache -f -t "$HICOLOR_BASE" 2>/dev/null || true
fi
if command -v update-desktop-database &>/dev/null; then
    update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
fi
if command -v xdg-desktop-menu &>/dev/null; then
    xdg-desktop-menu forceupdate 2>/dev/null || true
fi

echo ""
echo "Done! CineSort should now appear in your application launcher."
echo "If the icon doesn't show immediately, log out and back in."
echo ""
echo "To launch from terminal:  APPIMAGE_EXTRACT_AND_RUN=1 ${APPIMAGE} --no-sandbox"
