# CineSort 🎬

**Professional media file organizer with intelligent metadata matching**

CineSort automatically detects, matches, and renames your movies and TV shows using metadata from TMDb, TVMaze, and OMDb (IMDb). Run it as a lightweight Docker container **or** install it as a native desktop app (`.deb` / AppImage) with a modern web interface.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Docker Pulls](https://img.shields.io/docker/pulls/aiulian25/cinesort)
![Docker Image Size](https://img.shields.io/docker/image-size/aiulian25/cinesort/latest)
![Version](https://img.shields.io/badge/version-1.2.0-green.svg)

---

## ✨ Features

### Core
- 🎯 **Smart Detection** — Automatically detects movies and TV shows from filenames (season, episode, year, quality tags, release group)
- 🔍 **Multi-Source Metadata** — TMDb, TVMaze, and OMDb (IMDb) with automatic fallback
- 📝 **Flexible Renaming** — Multiple naming templates (Plex, Jellyfin, Emby, custom), including flat in-place mode
- ✏️ **Rename In-Place** — Rename files without moving them — works on NAS/SMB shares
- 🔗 **Multiple Actions** — Rename, Move, Copy, Hard Link, Symlink, Dry-run (Test)

### Matching
- 🎬 **Adult-title support** — Optional Adult toggle unlocks TMDB results filtered by default; OMDb never filters
- 🏷️ **OMDb / IMDb source** — Falls back automatically to IMDb data when TMDB returns no results (e.g. niche or adult titles)
- 📊 **Cascade scoring** — Multi-metric confidence score (name similarity, year, S×E) with `original_title` awareness
- ✋ **Manual rename** — FileBot-style inline edit when auto-match fails: double-click, F2, or right-click → Edit

### UI / UX
- 📁 **Folder Browser** — Server-side folder navigation with multi-select
- 🖱️ **Drag & Drop** — Drop files or folders directly onto the left pane (fixed on deb/AppImage, Wayland-aware)
- 🔄 **Row reordering** — Drag rows to manually remap files to matches
- ✅ **Batch Operations** — Checkboxes + Ctrl+A select-all
- 🗑️ **Per-file Removal** — DEL key or right-click → Remove
- 📊 **Rename History** — Full log with undo support
- ⚙️ **Settings Panel** — Enter API keys in-app; no terminal required for desktop installs
- 🎨 **Modern Web UI** — Glassmorphic dark theme with action hint banners

### Platform
- 🐳 **Docker Native** — ~180 MB image, runs anywhere
- 🖥️ **Desktop App** — `.deb` and AppImage packages for Linux (Electron shell)
- 🔒 **Secure** — Non-root container, 0600 key file, contextIsolation, no eval
- 🌐 **NAS/SMB Ready** — Actionable error messages for network mount limitations

---

## 🚀 Quick Start

### Docker (recommended for servers / NAS)

```bash
mkdir -p ~/cinesort && cd ~/cinesort
wget https://raw.githubusercontent.com/aiulian25/cinesort/main/docker-compose.yml
nano docker-compose.yml   # Set your media paths and optional API keys
docker compose up -d
```

Open **http://localhost:8888** in your browser.

### Desktop (deb / AppImage)

Download the latest release from the [Releases page](https://github.com/aiulian25/cinesort/releases).

**Debian / Ubuntu:**
```bash
sudo dpkg -i cinesort_1.2.0_amd64.deb
cinesort                    # or launch from your application menu
```

**AppImage (any distro):**
```bash
chmod +x CineSort-1.2.0.AppImage
./CineSort-1.2.0.AppImage
```
On first launch the app **automatically** installs itself into your application launcher (writes a `.desktop` entry and all icon sizes). No installer script needed — just double-click or right-click → Open.

---

## 🔑 API Keys

### Which keys do you need?

| Source | Key required? | What it unlocks |
|--------|:---:|---|
| **TVMaze** | ✗ | Free TV episode data, no limits |
| **TMDb** | Optional | Movies + TV; your own key unlocks full API access. Adult titles require the Adult toggle. |
| **OMDb** | Optional | IMDb data; automatically used as fallback when TMDb returns no results. Unlocks niche and adult titles without the Adult toggle. |

### Getting a TMDb key (free)

1. Create a free account at [themoviedb.org](https://www.themoviedb.org/signup)
2. Go to **Settings → API** → request a Developer key
3. Copy the **API Key (v3 auth)** string

### Getting an OMDb key (free)

1. Go to [omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx)
2. Choose the **FREE** tier (1,000 requests/day)
3. Submit the form — your key arrives by e-mail within minutes

---

## ⚙️ Adding API Keys

### Option A — In-app Settings (desktop installs, easiest)

Click the **⚙ Settings** button in the top-right of the app.

- Paste your key into the relevant field (👁 toggles visibility)
- Click **Save & Apply**
- Keys take effect immediately — **no restart required**
- They are stored in `~/.config/cinesort/keys.env` with permissions `0600` (owner-read only) and survive app upgrades

### Option B — Docker Compose (server / NAS installs)

Uncomment and fill in the relevant lines in `docker-compose.yml`:

```yaml
environment:
  - PUID=1000
  - PGID=1000

  # TMDb — https://www.themoviedb.org/settings/api
  - TMDB_API_KEY=your_tmdb_api_key_here

  # OMDb — https://www.omdbapi.com/apikey.aspx
  - OMDB_API_KEY=your_omdb_api_key_here
```

Then restart:
```bash
docker compose up -d
```

> **Priority rule:** Environment variables always win over the `keys.env` file. If you set a key in `docker-compose.yml`, the in-app Settings panel will not overwrite it.

### Option C — Edit the config file manually (power users)

```bash
mkdir -p ~/.config/cinesort
nano ~/.config/cinesort/keys.env
```

```ini
# CineSort API keys
TMDB_API_KEY=your_tmdb_api_key_here
OMDB_API_KEY=your_omdb_api_key_here
```

```bash
chmod 600 ~/.config/cinesort/keys.env
```

Restart the app for changes to take effect when editing the file manually.

---

## 📋 Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PUID` | `1000` | User ID for file permissions — run `id -u` on your host |
| `PGID` | `1000` | Group ID for file permissions — run `id -g` on your host |
| `TMDB_API_KEY` | *(bundled)* | Custom TMDb v3 API key |
| `OMDB_API_KEY` | *(none)* | OMDb API key; OMDb is silently disabled without it |
| `CINESORT_HOST` | `0.0.0.0` | Server bind address |
| `CINESORT_PORT` | `8888` | Server port |

### Volume Mounts

| Mount | Purpose |
|-------|---------|
| `/data` | Rename history and configuration (persist this!) |
| `/media` | Your media root — can be split into sub-mounts |
| `/mnt` | Alternative root — browse mounts directly |

**Examples:**

```yaml
# Single library
volumes:
  - cinesort-data:/data
  - /mnt/media:/media

# Multiple libraries
volumes:
  - cinesort-data:/data
  - /mnt/movies:/media/movies
  - /mnt/tv:/media/tv
  - /mnt/downloads:/media/downloads

# NFS/SMB network share
volumes:
  - cinesort-data:/data
  - /mnt/nas:/media:rw
```

---

## 📖 Usage Guide

### 1. Scan files

- Enter a folder path in the scan bar, or **drag & drop** files/folders onto the left pane
- Use **Browse** for server-side folder navigation with checkbox multi-select
- Toggle **Recursive** to include sub-folders
- Click **Scan**

### 2. Match metadata

- Select a **Source** from the toolbar dropdown:
  - **TMDb** — best for mainstream movies and TV (default)
  - **TVMaze** — alternative TV source, completely free
  - **OMDb (IMDb)** — IMDb data; ideal for niche or adult titles
- Enable **Adult** if you need titles that TMDb filters by default
- Click **Match**
- If multiple shows are found you will be asked to choose one

### 3. Manual rename (when auto-match fails)

When a file shows **No match found** in the right pane:

- **Double-click** the row, or press **F2** with it focused, or **right-click → Edit name manually**
- Type the new filename stem (extension is preserved automatically)
- Press **Enter** to confirm or **Esc** to cancel
- The row gets an amber **manual** badge and the Rename button enables immediately

### 4. Choose a template

| Preset | Template | Use for |
|--------|----------|---------|
| **TV** | `{n}/Season {s}/{n} - {s00e00} - {t}` | Plex/Jellyfin TV libraries |
| **Film** | `{n} ({y})/{n} ({y})` | Plex/Jellyfin movie libraries |
| **Anime** | `{n}/{n} - {absolute} - {t}` | Absolute-numbered anime |
| **Flat** | `{n} - {s00e00} - {t}` | Rename in-place, no folders |

Or type your own using `{n}`, `{y}`, `{s}`, `{e}`, `{s00e00}`, `{t}`, `{absolute}`, `{source}`, `{vf}`, `{group}`.

### 5. Choose an action

| Action | Description |
|--------|-------------|
| **Rename (in-place)** | Renames the file in its current folder — works on SMB/NAS |
| **Test (Dry Run)** | Previews results without touching any files |
| **Move** | Moves files to new paths built from the template |
| **Copy** | Copies to new path, keeps originals |
| **Hard Link** | Same-filesystem hard link at the new path |
| **Symlink** | Symbolic link — not supported on SMB/FAT |

### 6. Review and rename

- Uncheck any rows you want to skip
- Click **Rename**
- Results are shown immediately; failures include the reason
- All operations are recorded in **History** (top-right button) with per-operation **Undo**

---

## 🐛 Troubleshooting

### Drag & Drop not working (deb / AppImage)

The desktop packages apply `--no-sandbox` automatically and switch Electron to Wayland-native mode when `XDG_SESSION_TYPE=wayland`. If drag & drop still fails:

```bash
# Check which session type you are running
echo $XDG_SESSION_TYPE

# Run from terminal to see errors
/opt/CineSort/cinesort --no-sandbox
```

### OMDb source is greyed out / returns nothing

OMDb requires a key. Click **⚙ Settings** and enter your key, or check that `OMDB_API_KEY` is set in `docker-compose.yml`.

### Adult titles not appearing

Enable the **Adult** checkbox in the toolbar before clicking Match. This passes `include_adult=true` to the TMDb search API. If the title still doesn't appear, switch Source to **OMDb** — OMDb does not filter adult content regardless of the toggle.

### Permission denied when renaming

```bash
# Find your user/group IDs
id -u && id -g
```

Update `PUID`/`PGID` in `docker-compose.yml` and restart. For network mounts add `:rw`:
```yaml
- /mnt/nas:/media:rw
```

### Container won't start

```bash
docker logs cinesort
```

Common causes: port 8888 already in use; volume path does not exist; invalid `PUID`/`PGID`.

### Web UI unreachable

```bash
docker ps | grep cinesort          # Is it running?
curl http://localhost:8888          # Does it respond?
docker inspect cinesort | grep Health
```

---

## 🔧 API Sources

| Source | Free | Key | Rate limit | Notes |
|--------|:----:|:---:|-----------|-------|
| **TMDb** | ✅ | Optional | ~50 req/s | Mainstream movies & TV; adult flag available |
| **TVMaze** | ✅ | None | Reasonable use | TV only |
| **OMDb** | ✅ | Required | 1,000/day (free tier) | IMDb data; no adult filtering |

---

## 🛠️ Docker Compose Examples

### Minimal

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

### Full (with API keys and resource limits)

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
      - TMDB_API_KEY=your_tmdb_api_key_here
      - OMDB_API_KEY=your_omdb_api_key_here
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

## 📊 Technical Details

| Item | Detail |
|------|--------|
| **Docker base** | Python 3.11 (Debian slim) |
| **Image size** | ~180 MB |
| **Architecture** | amd64 (x86_64) |
| **Runtime** | FastAPI + Uvicorn |
| **RAM usage** | ~150 MB |
| **Desktop shell** | Electron 35 |
| **User** | Non-root (UID configurable via PUID) |
| **Key storage** | `~/.config/cinesort/keys.env` — mode `0600` |
| **Health check** | `GET /` every 30 s |

---

## 🚦 Building from Source

```bash
git clone https://github.com/aiulian25/cinesort.git
cd cinesort
docker build -t cinesort:latest .
docker compose -f docker-compose.dev.yml up -d
```

**Desktop build:**
```bash
npm install
npm run build        # produces .deb and AppImage in dist/
```

---

## 📝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Open a pull request

---

## 📜 License

MIT License — see [LICENSE](LICENSE) for details.

---

## 📦 Changelog

### v1.2.0
- **OMDb / IMDb source** — third metadata source backed by IMDb data; falls back automatically when TMDb returns no results. Requires a free API key (1,000 req/day).
- **Adult-title support** — Adult checkbox in the toolbar passes `include_adult=true` to TMDb; OMDb never filters.
- **In-app Settings panel** — ⚙ gear button opens a modal to enter/update API keys without touching a terminal or config file. Keys are saved to `~/.config/cinesort/keys.env` (mode 0600) and take effect immediately.
- **Manual rename (FileBot-style)** — When auto-match fails, double-click a row (or press F2, or right-click → Edit name manually) to type a custom filename. Extension is preserved automatically. Amber **manual** badge distinguishes manual entries from auto-matches. Right-click → Clear to revert.
- **Drag & Drop fixed on deb / AppImage** — Electron sandbox is now configured programmatically (`--no-sandbox` flag + `chrome-sandbox` setuid) so DnD works without manual desktop-entry patching. Wayland sessions automatically switch to ozone/Wayland mode so file managers (Nautilus, Dolphin) can hand paths to the app.
- **Improved movie scoring** — Uses `cascade_score` (year bonus/penalty, `original_title` comparison) instead of plain string similarity; score is capped at 1.0.
- **Keyboard shortcut** — F2 opens inline edit for the focused row; Delete/Ctrl+A are blocked during text input.
- **Duplicate function bug** — Removed a silently duplicated `showSelectionDialog` declaration.

### v1.1.0
- Rename In-Place action
- Per-file removal (DEL key / right-click)
- Action hint banner
- Flat template preset
- Improved SMB error handling

### v1.0.0
- Initial public release

---

## 🙏 Acknowledgments

- **TMDb** — Movie and TV metadata (https://www.themoviedb.org/)
- **TVMaze** — TV show information (https://www.tvmaze.com/)
- **OMDb** — IMDb data API (https://www.omdbapi.com/)
- **FastAPI** — Modern Python web framework
- **Electron** — Cross-platform desktop shell
- **Docker** — Containerization platform

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/aiulian25/cinesort/issues)
- **Docker Hub**: [aiulian25/cinesort](https://hub.docker.com/r/aiulian25/cinesort)

---

**Made with ❤️ for media enthusiasts**


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
