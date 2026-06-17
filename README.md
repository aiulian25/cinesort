# CineSort 🎬

**Professional media file organizer with intelligent metadata matching**

CineSort automatically detects, matches, and renames your movies and TV shows using metadata from TMDb, TVMaze, and OMDb (IMDb). Run it as a lightweight Docker container **or** install it as a native desktop app (`.deb` / AppImage) with a modern web interface.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Docker Pulls](https://img.shields.io/docker/pulls/aiulian25/cinesort)
![Docker Image Size](https://img.shields.io/docker/image-size/aiulian25/cinesort/latest)
![Version](https://img.shields.io/badge/version-1.2.5-green.svg)

---

## ✨ Features

### Core
- 🎯 **Smart Detection** — Automatically detects movies and TV shows from filenames (season, episode, year, quality tags, release group)
- 🔍 **Multi-Source Metadata** — TMDb, TVMaze, and OMDb (IMDb), merged and ranked by confidence
- 📝 **Flexible Renaming** — Template-based naming with a token palette and **live preview**, including flat in-place mode
- ✏️ **Rename In-Place** — Rename files without moving them — works on NAS/SMB shares
- 🔗 **Multiple Actions** — Rename, Move, Copy, Hard Link, Symlink, Dry-run (Test)

### Matching
- 📊 **Cascade scoring + breakdown** — Multi-metric confidence score (name, year, S×E, absolute) with `original_title` awareness; the **View metadata** dialog shows *why* a match was chosen
- 🟢🟡🔴 **Confidence gate** — High / Review / Low tiers; matches below 40% are flagged **review** and are **not** auto-selected for renaming, so a weak guess can never rename a file by accident
- 🔁 **Smart fallback search** — Retries with the year dropped, then progressively trimmed titles, so noisy filenames still match
- 🌀 **Anime / absolute numbering** — Cumulative absolute episode numbers are computed and matched
- 📅 **Year disambiguation** — Auto-resolves same-named shows when the filename carries a year (skips an unnecessary prompt)
- 🎬 **Adult-title support** — Optional Adult toggle unlocks TMDB results filtered by default; OMDb never filters
- ✋ **Manual rename** — FileBot-style inline edit when auto-match fails: double-click, F2, or right-click → Edit

### UI / UX
- 🎨 **Three themes** — **Dark** (default), **Light**, and **Aurora** (a neon-glass theme); switch in ⚙ Settings → Appearance, remembered per device
- 📁 **Folder picker** — Native OS file/folder picker on desktop (reaches your whole filesystem); a rich in-app browser on Docker/web with a shortcuts sidebar, editable path + breadcrumb, type-ahead filter, "media only" toggle, cross-folder multi-select, and full keyboard navigation
- 🧰 **Template builder** — Insert `{tokens}` from a palette and see a live preview of the resulting path
- ⚡ **Bulk selection** — One-click "Matched", "≥60%", and "Clear unmatched"
- ⚠️ **Inline conflict resolution** — Resolve duplicate/exists conflicts in place with **Skip** or **Rename → (2)**
- 🖱️ **Drag & Drop** — Drop files or folders directly onto the left pane (deb/AppImage, Wayland-aware)
- 🔄 **Row reordering** — Drag rows to manually remap files to matches
- 🗑️ **Per-file Removal** — DEL key or right-click → Remove
- 📂 **Show in folder** — Reveal the original file in your file manager (desktop)
- 💾 **Remembers your setup** — Source, action, template, and last folder persist between sessions
- 📊 **Rename History** — Full log with per-operation undo; native confirm dialogs replaced with themed ones
- ♿ **Accessible** — ARIA roles + visible keyboard focus rings on lists and controls
- ⚙️ **Settings Panel** — Enter API keys in-app; no terminal required for desktop installs

### Platform & reliability
- 🐳 **Docker Native** — ~180 MB image, runs anywhere
- 🖥️ **Desktop App** — `.deb` and AppImage packages for Linux (Electron shell)
- 🔌 **Conflict-free launch** — Picks a free port automatically, so a stale/duplicate instance can never block startup
- 🖼️ **Reliable rendering on Linux** — Software compositing avoids the all-black-window issue seen on Wayland/Intel (override with `CINESORT_ENABLE_GPU=1`)
- 🔁 **Always-fresh UI** — Static assets sent with `Cache-Control: no-cache`, so a rebuilt container never serves stale JavaScript
- 🤝 **No launcher collisions** — The AppImage won't shadow a deb install's menu entry, and stages itself to a stable path
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
sudo dpkg -i cinesort_1.2.5_amd64.deb
cinesort                    # or launch from your application menu
```

**AppImage (any distro):**
```bash
chmod +x CineSort-1.2.5.AppImage
./CineSort-1.2.5.AppImage
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
| `CINESORT_BROWSE_ROOTS` | *(none)* | Extra folders the in-app browser may expose, in addition to `/mnt` and `/media` (`:`-separated, e.g. `/srv/tv:/srv/movies`). Only add paths you also mount. Shown as quick-access shortcuts. |
| `CINESORT_ENABLE_GPU` | *(unset)* | Desktop only: set to `1` to re-enable GPU hardware acceleration (disabled by default on Linux to avoid black-window issues) |

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
- Click **Browse**:
  - **Desktop (deb/AppImage):** opens your native OS picker — choose folders or files anywhere on the machine
  - **Docker / web:** opens the in-app browser — shortcuts sidebar, editable path/breadcrumb, type-ahead filter, "media only" toggle, and checkbox multi-select that **persists across folders**; navigate with ↑/↓, Space to select, Enter to open, Backspace to go up
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

Or build your own: type tokens directly, or click them from the **token palette** under the template field — a **live preview** shows the resulting path for the first file as you edit. Available tokens: `{n}`, `{y}`, `{s}`, `{e}`, `{s00e00}`, `{t}`, `{absolute}`, `{source}`, `{vf}`, `{group}`.

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

- Check the confidence tier on each match — **High** (green), **Review** (amber, <60%), **Low** (red, <40%, auto-deselected)
- Use the bulk buttons above the list to quickly select **Matched**, **≥60%**, or **Clear unmatched**
- Uncheck any rows you want to skip
- Click **Rename**
- If any **conflicts** are found (duplicate destination / file already exists), resolve them inline with **Skip** or **Rename → (2)**
- Results are shown immediately; failures include the reason
- All operations are recorded in **History** (top-right button) with per-operation **Undo**

### Change the theme

Open **⚙ Settings → Appearance** and pick **Dark**, **Light**, or **Aurora**. The choice applies instantly and is remembered on this device.

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

### Desktop app shows a black window (Linux)

As of v1.2.4 the desktop app uses software compositing on Linux, which fixes the all-black-window issue seen on some Wayland/Intel setups. If your GPU renders fine and you want hardware acceleration back, launch with:
```bash
CINESORT_ENABLE_GPU=1 /opt/CineSort/cinesort
```

### Desktop app won't launch from the app menu (spinner, then nothing)

Almost always a **stale `.desktop` entry** — e.g. you ran the AppImage once (it self-registers a launcher), then moved/deleted that AppImage, and its user-local entry now shadows the deb's and points at a missing file. Fix:
```bash
# Inspect what the menu entry runs:
gtk-launch cinesort
# Remove a stale user-local entry so the deb's entry is used:
rm -f ~/.local/share/applications/cinesort.desktop
update-desktop-database ~/.local/share/applications
```
v1.2.5+ AppImages detect an installed deb and no longer create a shadowing entry. (Running from a terminal — `/opt/CineSort/cinesort` — bypasses the menu entry and always works.)

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

### v1.2.5
- **AppImage no longer shadows a deb install** — when a system (deb) install is detected, the AppImage skips self-registering its menu entry (and removes any stale one it left before), fixing "won't launch from the menu". It also stages itself to `~/.local/bin/CineSort.AppImage` so moving/deleting the downloaded file doesn't break the launcher.

### v1.2.4
- **Conflict-free launch** — the desktop app now resolves a free port at startup instead of hardcoding one, so a leftover/duplicate instance can no longer cause "fails to launch" (`address already in use`).

### v1.2.3
- **Black-window fix (Linux)** — disables GPU compositing by default on Linux (Wayland/Intel and others rendered an all-black window). Override with `CINESORT_ENABLE_GPU=1`.
- **Browse opens at a real root** — the in-app browser now opens at the first existing mounted volume (e.g. `/media`) instead of a hardcoded `/mnt` that may not exist in your container.
- **Always-fresh assets** — `Cache-Control: no-cache` on the web UI so a rebuilt container never serves stale JavaScript (one hard refresh needed the first time).

### v1.2.2
- **Three themes** — added **Light** and **Aurora** (neon-glass) alongside Dark, with a live theme picker in ⚙ Settings → Appearance (remembered per device).
- **Fixed non-working modal buttons** — Cancel / Close / Done in Settings, History, and dialogs now work (they were broken by a scope bug).
- **Themed confirm dialogs** — replaced the off-theme native `confirm()` popups (Clear History, Undo) with in-app themed dialogs.
- **Consistent dropdown colours** — the Source `<select>` menu now matches the theme.

### v1.2.1
- **Better folder & file selection** — native OS picker on deb/AppImage; the in-app browser gained a shortcuts sidebar, editable path + breadcrumb, type-ahead filter, "media only" toggle, selection that persists across folders, and keyboard navigation. New `CINESORT_BROWSE_ROOTS` env var for extra browsable roots.
- **Better matching** — confidence gate (low-confidence matches flagged "review" and not auto-selected) with a three-tier colour legend; per-metric **match breakdown** in View metadata; fallback search queries; cross-source movie merge; O(1) exact-episode matching; real absolute (anime) numbering; year-based show disambiguation.
- **UI polish** — template token palette + live preview; bulk select (Matched / ≥60% / Clear unmatched); inline conflict resolution (Skip / Rename → (2)); "Show in folder" on desktop; remembers last-used source/action/template/folder; accessibility roles + focus rings; elapsed-time indicator during long matches.

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
