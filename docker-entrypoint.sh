#!/bin/bash
set -e

# CineSort Docker Entrypoint Script
# Handles user permissions and initialization

echo "=========================================="
echo "  CineSort - Media File Organizer"
echo "=========================================="

# Handle PUID/PGID for file permissions
PUID=${PUID:-1000}
PGID=${PGID:-1000}

echo "Starting with UID: $PUID, GID: $PGID"

# Update user/group IDs if they differ from defaults
if [ "$PUID" != "1000" ] || [ "$PGID" != "1000" ]; then
    echo "Updating cinesort user to UID:$PUID, GID:$PGID..."
    groupmod -o -g "$PGID" cinesort 2>/dev/null || true
    usermod -o -u "$PUID" cinesort 2>/dev/null || true
fi

# Ensure data directory exists and has correct permissions
if [ ! -d "/data" ]; then
    mkdir -p /data
fi

# Fix permissions
chown -R "$PUID:$PGID" /data 2>/dev/null || true
chown -R "$PUID:$PGID" /app 2>/dev/null || true

# Create history file if it doesn't exist
# (CINESORT_DATA_DIR=/data makes this the real store the app reads/writes)
if [ ! -f "/data/history.json" ]; then
    echo "[]" > /data/history.json
    chown "$PUID:$PGID" /data/history.json
fi

# Config dir for UI-saved API keys (keys.env, written 0600 by the app)
mkdir -p /data/config
chown "$PUID:$PGID" /data/config

echo "Data directory: /data"
echo "Media directory: /media (mount your media here)"
echo "Web UI: http://localhost:${CINESORT_PORT:-8888}"
echo "=========================================="
echo ""

# Execute command as cinesort user.
# When the command is EXACTLY the image's stock CMD (see Dockerfile CMD — keep
# the string below in sync with it), honor CINESORT_HOST/CINESORT_PORT so the
# documented env vars actually control the bind address. Any other command —
# a compose `command:` override, a debug shell, or even the same uvicorn line
# with the user's own --port — passes through verbatim and is never rewritten.
if [ "$*" = "python -m uvicorn app.main:app --host 0.0.0.0 --port 8888" ]; then
    exec gosu cinesort python -m uvicorn app.main:app \
        --host "${CINESORT_HOST:-0.0.0.0}" --port "${CINESORT_PORT:-8888}"
fi
exec gosu cinesort "$@"
