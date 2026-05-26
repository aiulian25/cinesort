# CineSort 🎬

**Professional media file organizer with intelligent metadata matching**

CineSort automatically detects, matches, and renames your movies and TV shows using metadata from TMDb and TVMaze APIs. Run it as a lightweight Docker container with a modern web interface.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Docker Pulls](https://img.shields.io/docker/pulls/aiulian25/cinesort)
![Docker Image Size](https://img.shields.io/docker/image-size/aiulian25/cinesort/latest)
![Version](https://img.shields.io/badge/version-1.1.0-green.svg)

---

## ✨ Features

- 🎯 **Smart Detection** - Automatically detects movies and TV shows from filenames
- 🔍 **Metadata Matching** - Fetches accurate metadata from TMDb and TVMaze
- 📝 **Flexible Renaming** - Multiple naming templates (Plex, Jellyfin, Emby, custom)
- ✏️ **Rename In-Place** - Rename files without moving them — works on NAS/SMB shares
- 📁 **Folder Browser** - Server-side folder navigation with multi-select support
- ✅ **Batch Operations** - Select multiple files with checkboxes or Ctrl+A
- 🗑️ **Per-file Removal** - Remove individual files from the list with DEL key or right-click
- 📊 **Rename History** - Track all rename operations with undo support
- 🎨 **Modern Web UI** - Beautiful glassmorphic dark theme with action hint banners
- 🐳 **Docker Native** - 180MB image, runs anywhere
- 🔒 **Secure** - Runs as non-root user with configurable PUID/PGID
- 🆓 **Free APIs** - No registration required (optional TMDb API key for heavy use)
- 🌐 **NAS/SMB Ready** - Actionable error messages for network mount limitations

---

## 🚀 Quick Start

### Prerequisites
- Docker and Docker Compose installed
- Media files on your host system

### Installation

1. **Create directory and download docker-compose.yml**:
```bash
mkdir -p ~/cinesort && cd ~/cinesort
wget https://raw.githubusercontent.com/aiulian25/cinesort/main/docker-compose.yml
```

2. **Edit docker-compose.yml** to configure your media directories:
```bash
nano docker-compose.yml  # or use your preferred editor
```

Update the volumes section with your media paths:
```yaml
volumes:
  - cinesort-data:/data
  - /your/media/path:/media  # Change this to your actual media directory
```

3. **Start CineSort**:
```bash
docker compose up -d
```

4. **Access the web interface**:
```
http://localhost:8888
```

That's it! 🎉

---

## 📋 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PUID` | `1000` | User ID for file permissions (match your host user) |
| `PGID` | `1000` | Group ID for file permissions (match your host group) |
| `TMDB_API_KEY` | *(provided)* | Optional: Custom TMDb API key ([get yours here](https://www.themoviedb.org/settings/api)) |
| `CINESORT_HOST` | `0.0.0.0` | Server bind address |
| `CINESORT_PORT` | `8888` | Server port |

### Finding Your PUID/PGID

On your host system, run:
```bash
id -u  # Returns PUID
id -g  # Returns PGID
```

Update docker-compose.yml:
```yaml
environment:
  - PUID=1000  # Your user ID
  - PGID=1000  # Your group ID
```

### Volume Mounts

**Required volumes**:
- `/data` - Persistent storage for rename history and configuration
- Media directories - Mount your movies/TV shows (can be multiple)

**Example configurations**:

**Single media directory**:
```yaml
volumes:
  - cinesort-data:/data
  - /mnt/media:/media
```

**Multiple directories**:
```yaml
volumes:
  - cinesort-data:/data
  - /mnt/movies:/media/movies
  - /mnt/tv:/media/tv
  - /mnt/downloads:/media/downloads
```

**Network mounts** (NFS/SMB):
```yaml
volumes:
  - cinesort-data:/data
  - /mnt/nas:/media:rw  # :rw for read-write access
```

---

## 📖 Usage Guide

### 1. **Scan Directory**
- Click the **Browse** button or enter a path manually
- Navigate through folders with server-side browser
- Select files/folders with checkboxes or Ctrl+A
- Click **Scan Selected** to detect media files

### 2. **Review Matches**
- CineSort displays detected metadata with confidence scores
- Green badges (High) indicate strong matches
- Yellow badges (Medium/Low) may need manual verification
- Poster images help confirm correct matches

### 3. **Select Naming Template**
Choose from pre-configured templates:
- **Plex**: `Movie Title (Year).ext` / `Show Title - S01E02 - Episode Title.ext`
- **Jellyfin**: `Movie Title [imdbid-tt1234567].ext`
- **Emby**: Similar to Jellyfin
- **Simple**: Basic title-based naming
- **Custom**: Define your own pattern

### 4. **Preview & Execute**
- Review new filenames in the preview
- Uncheck any files you don't want to rename
- Click **Execute Rename** to apply changes
- All operations are logged in rename history

### 5. **History & Undo**
- View rename history with timestamps
- Undo operations if needed
- Export history for records

---

## 🎨 Folder Browser

The built-in folder browser provides:
- **Server-side navigation** - Secure browsing of mounted directories
- **Multi-select** - Checkboxes for individual selection
- **Batch select** - "Select All" / "Deselect All" buttons
- **Keyboard shortcuts** - Ctrl+A to select all
- **Breadcrumb navigation** - Click to jump to parent folders
- **Restricted access** - Only browses `/media` and `/mnt` directories

---

## 🛠️ Docker Compose Examples

### Basic Setup
```yaml
services:
  cinesort:
    image: aiulian25/cinesort:latest
    container_name: cinesort
    ports:
      - "8888:8888"
    environment:
      - PUID=1000
      - PGID=1000
    volumes:
      - cinesort-data:/data
      - /path/to/media:/media
    restart: unless-stopped

volumes:
  cinesort-data:
```

### Advanced Setup (with resource limits)
```yaml
services:
  cinesort:
    image: aiulian25/cinesort:latest
    container_name: cinesort
    ports:
      - "8888:8888"
    environment:
      - PUID=1000
      - PGID=1000
      - TMDB_API_KEY=your_api_key_here
    volumes:
      - cinesort-data:/data
      - /mnt/movies:/media/movies
      - /mnt/tv:/media/tv
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 1G
        reservations:
          memory: 256M
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  cinesort-data:
```

---

## 🔧 API Information

### TMDb (The Movie Database)
- **Default**: Free API key included for testing
- **Rate Limits**: Generous limits for personal use
- **Custom Key**: Recommended for heavy use - [register here](https://www.themoviedb.org/settings/api)
- **No Expiration**: Free keys don't expire (unless abused)

### TVMaze
- **No API key required** - Completely free
- **No rate limits** for reasonable use
- **TV show metadata** - Episode titles, air dates, summaries

---

## 🐛 Troubleshooting

### Permission Denied Errors

**Problem**: `[Errno 13] Permission denied` when renaming files

**Solutions**:
1. Match PUID/PGID to your host user:
   ```bash
   id -u && id -g  # Get your user/group IDs
   ```
   
2. For network mounts (NFS/CIFS), add `:rw` flag:
   ```yaml
   volumes:
     - /mnt/nas:/media:rw
   ```

3. Check file ownership on host:
   ```bash
   ls -la /path/to/media
   ```

### Container Won't Start

**Check logs**:
```bash
docker logs cinesort
```

**Common issues**:
- Port 8888 already in use (change in docker-compose.yml)
- Volume mount paths don't exist
- Invalid PUID/PGID values

### Cannot Access Web UI

1. Verify container is running:
   ```bash
   docker ps | grep cinesort
   ```

2. Check container health:
   ```bash
   docker inspect cinesort | grep -i health
   ```

3. Test connectivity:
   ```bash
   curl http://localhost:8888
   ```

### Folder Browser Shows Empty

- Ensure media directories are properly mounted
- Check container has read access:
  ```bash
  docker exec cinesort ls -la /media
  ```

---

## 📊 Technical Details

**Image Specifications**:
- **Base**: Python 3.11 (Debian slim)
- **Size**: ~180MB
- **Architecture**: amd64 (x86_64)
- **Runtime**: FastAPI + Uvicorn
- **Memory**: ~150MB RAM usage
- **User**: Runs as non-root (UID 1000 by default)

**Health Check**:
- Endpoint: `GET /`
- Interval: 30 seconds
- Timeout: 3 seconds
- Retries: 3

**Security**:
- No root privileges required
- Sandboxed file access (only mounted directories)
- API key management via environment variables
- No hardcoded credentials

---

## 🎯 Naming Templates

### Plex Format
**Movies**: `Movie Title (Year).ext`
- Example: `The Matrix (1999).mkv`

**TV Shows**: `Show Title - S01E02 - Episode Title.ext`
- Example: `Breaking Bad - S01E01 - Pilot.mkv`

### Jellyfin Format
**Movies**: `Movie Title [imdbid-tt1234567].ext`
**TV Shows**: `Show Title [tvdbid-123456] - S01E02 - Episode Title.ext`

### Simple Format
**Movies**: `Movie Title (Year).ext`
**TV Shows**: `Show Title S01E02.ext`

---

## 🚦 Building from Source

If you want to build the image yourself instead of using the pre-built one:

```bash
git clone https://github.com/aiulian25/cinesort.git
cd cinesort
docker build -t cinesort:latest .
docker compose up -d
```

---

## 📝 Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

---

## 📜 License

MIT License - see [LICENSE](LICENSE) file for details

---

## � Changelog

### v1.1.0
- **Rename In-Place action** — renames files using an atomic OS rename, keeping them in their current folder. No new directories are ever created. Works on SMB/NFS/NAS mounts.
- **Per-file removal** — remove individual files from the scan list with the `Del` key or right-click → "Remove from list". Arrow keys navigate between rows.
- **Action hint banner** — colour-coded description of what each action (Rename, Move, Copy, etc.) will do before you commit.
- **Flat template preset** — one-click preset with no path separators, safe for in-place renaming.
- **Improved SMB error handling** — `EOPNOTSUPP`, `EXDEV`, `EACCES`, `ENOSPC` now surface as clear, actionable messages instead of raw Python tracebacks.

### v1.0.0
- Initial public release

---

## �🙏 Acknowledgments

- **TMDb** - Movie and TV metadata (https://www.themoviedb.org/)
- **TVMaze** - TV show information (https://www.tvmaze.com/)
- **FastAPI** - Modern Python web framework
- **Docker** - Containerization platform

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/aiulian25/cinesort/issues)
- **Docker Hub**: [aiulian25/cinesort](https://hub.docker.com/r/aiulian25/cinesort)

---

**Made with ❤️ for media enthusiasts**
