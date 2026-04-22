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
if [ ! -f "/data/history.json" ]; then
    echo "[]" > /data/history.json
    chown "$PUID:$PGID" /data/history.json
fi

echo "Data directory: /data"
echo "Media directory: /media (mount your media here)"
echo "Web UI: http://localhost:${CINESORT_PORT:-8888}"
echo "=========================================="
echo ""

# Execute command as cinesort user
exec gosu cinesort "$@"
