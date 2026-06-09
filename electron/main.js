const { app, BrowserWindow, nativeImage } = require("electron");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

// ── Linux sandbox & Wayland fix ───────────────────────────────────────────────
// Must be called BEFORE app.whenReady().
// On Linux, chrome-sandbox needs to be setuid root for the renderer sandbox to
// work. Most distributions (and deb/AppImage installs) don't configure this,
// so the sandbox launch fails and webUtils.getPathForFile() — used by drag-and-
// drop — returns empty paths. Disabling the OS-level sandbox here restores DnD
// while contextIsolation + contextBridge remain in effect for JS isolation.
//
// For Wayland sessions: Electron defaults to XWayland mode. Native-Wayland file
// managers (Nautilus, Dolphin ≥ 23) cannot DnD into XWayland windows at the
// compositor level. Switching to ozone/Wayland mode fixes cross-app DnD.
if (process.platform === "linux") {
    app.commandLine.appendSwitch("no-sandbox");
    app.commandLine.appendSwitch("disable-gpu-sandbox");
    // Run under XWayland rather than native Wayland. On hybrid GPU systems
    // (NVIDIA Optimus + Intel) the native Wayland ozone backend fights with
    // the GPU compositor and produces a blank window. XWayland composites
    // through Xorg which handles Optimus transparently, and drag-and-drop
    // works correctly because Electron and the file manager share the same
    // X11 surface. The no-sandbox flag above already fixes DnD path access.
}
// ─────────────────────────────────────────────────────────────────────────────

let pyProc = null;
let mainWindow = null;
const PORT = 47299;

function getIconPath() {
    // Try multiple locations for the icon (order: packaged app → dev fallbacks)
    const locations = [
        path.join(process.resourcesPath, "app", "app", "CineSort.png"),
        path.join(process.resourcesPath, "app", "CineSort.png"),
        path.join(__dirname, "..", "app", "CineSort.png"),
        path.join(__dirname, "..", "build", "icons", "512x512.png"),
        path.join(__dirname, "..", "build", "icons", "256x256.png"),
    ];
    
    for (const loc of locations) {
        try {
            fs.accessSync(loc);
            return loc;
        } catch {}
    }
    return null;
}

function findPython() {
    // In packaged app, venv is in resources/venv
    const packaged = path.join(process.resourcesPath, "venv", "bin", "python3");
    const dev = path.join(__dirname, "..", ".venv", "bin", "python3");
    try {
        require("fs").accessSync(packaged);
        return packaged;
    } catch {
        return dev;
    }
}

function findCwd() {
    const packaged = path.join(process.resourcesPath, "app");
    const dev = path.join(__dirname, "..");
    try {
        require("fs").accessSync(path.join(packaged, "app", "main.py"));
        return packaged;
    } catch {
        return dev;
    }
}

function startPython() {
    const python = findPython();
    const cwd = findCwd();
    console.log(`[main] Starting uvicorn: ${python} in ${cwd}`);

    // ── Load user API keys from ~/.config/cinesort/keys.env ──────────────────
    // This ensures deb/AppImage users who set keys via the Settings UI have
    // them available to the Python process from the very first request.
    // Keys already present in process.env (e.g. from systemd or a wrapper
    // script) are never overwritten — they always take priority.
    const childEnv = { ...process.env };
    try {
        const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
        const keysFile  = path.join(xdgConfig, "cinesort", "keys.env");
        if (fs.existsSync(keysFile)) {
            const lines = fs.readFileSync(keysFile, "utf8").split(/\r?\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#")) continue;
                const eq = trimmed.indexOf("=");
                if (eq < 1) continue;
                const key   = trimmed.slice(0, eq).trim();
                const value = trimmed.slice(eq + 1).trim();
                // Only inject managed keys; never overwrite existing env vars
                if (["TMDB_API_KEY", "OMDB_API_KEY"].includes(key) && !(key in childEnv) && value) {
                    childEnv[key] = value;
                    console.log(`[main] Loaded ${key} from keys.env`);
                }
            }
        }
    } catch (err) {
        console.warn("[main] Could not read keys.env:", err.message);
    }
    // ─────────────────────────────────────────────────────────────────────────

    pyProc = spawn(python, ["-m", "uvicorn", "app.main:app", "--port", String(PORT), "--host", "127.0.0.1"], {
        cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
    });

    pyProc.stdout.on("data", d => console.log("[py]", d.toString().trim()));
    pyProc.stderr.on("data", d => console.log("[py]", d.toString().trim()));
    pyProc.on("exit", (code) => {
        console.log(`[py] exited with code ${code}`);
        pyProc = null;
    });
}

function waitForServer(timeout = 20000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            http.get(`http://127.0.0.1:${PORT}/`, (res) => {
                resolve();
            }).on("error", () => {
                if (Date.now() - start > timeout) {
                    reject(new Error("Python server did not start in time"));
                } else {
                    setTimeout(check, 300);
                }
            });
        };
        check();
    });
}

function installDesktopEntry() {
    // Detect AppImage: $APPIMAGE is set by the AppImage runtime in all modes
    // (FUSE-mounted AND --appimage-extract-and-run). The /.mount_ path check
    // only covers FUSE mode, so prefer the env var.
    const isAppImage = !!process.env.APPIMAGE || process.resourcesPath.includes("/.mount_") || process.resourcesPath.includes("/tmp/appimage_extracted");
    if (!isAppImage) return;
    const appImagePath = process.env.APPIMAGE || process.execPath;

    try {
        const homeDir = os.homedir();
        const appsDir = path.join(homeDir, ".local", "share", "applications");
        const iconsDir = path.join(homeDir, ".local", "share", "icons", "hicolor", "512x512", "apps");
        const desktopFile = path.join(appsDir, "cinesort.desktop");

        // Find icon: search multiple locations to cover FUSE mount and extract-and-run
        const iconCandidates = [
            path.join(process.resourcesPath, "app", "app", "CineSort.png"),
            path.join(process.resourcesPath, "app", "CineSort.png"),
            path.join(__dirname, "..", "app", "CineSort.png"),
        ];
        const iconSrc = iconCandidates.find(p => fs.existsSync(p));

        fs.mkdirSync(appsDir, { recursive: true });
        fs.mkdirSync(iconsDir, { recursive: true });

        // Install all available icon sizes
        const hicolorBase = path.join(homeDir, ".local", "share", "icons", "hicolor");
        const iconSizes = ["16x16", "24x24", "32x32", "48x48", "64x64", "96x96", "128x128", "256x256", "512x512"];
        for (const size of iconSizes) {
            const sizeSrc = path.join(__dirname, "..", "build", "icons", `${size}.png`);
            if (fs.existsSync(sizeSrc)) {
                const sizeDir = path.join(hicolorBase, size, "apps");
                fs.mkdirSync(sizeDir, { recursive: true });
                fs.copyFileSync(sizeSrc, path.join(sizeDir, "cinesort.png"));
            }
        }
        // Also install the highest-res source icon
        if (iconSrc) {
            fs.copyFileSync(iconSrc, path.join(iconsDir, "cinesort.png"));
        }

        // Use APPIMAGE_EXTRACT_AND_RUN=1 so the desktop entry always works even
        // on systems where FUSE 2 mounting is unavailable (Ubuntu 22.04+).
        const desktop = [
            "[Desktop Entry]",
            "Version=1.0",
            "Type=Application",
            "Name=CineSort",
            "Comment=Professional media file organizer",
            `Exec=env APPIMAGE_EXTRACT_AND_RUN=1 ${appImagePath} --no-sandbox %U`,
            "Icon=cinesort",
            "Categories=AudioVideo;Video;Utility;",
            "Terminal=false",
            "StartupNotify=true",
            "StartupWMClass=CineSort",
        ].join("\n") + "\n";

        fs.writeFileSync(desktopFile, desktop, { mode: 0o644 });

        // Refresh icon cache and desktop database
        try { execFileSync("gtk-update-icon-cache", ["-f", "-t", path.join(homeDir, ".local", "share", "icons", "hicolor")]); } catch {}
        try { execFileSync("update-desktop-database", [appsDir]); } catch {}

        console.log("[main] Desktop entry installed:", desktopFile);
    } catch (err) {
        console.error("[main] Failed to install desktop entry:", err.message);
    }
}

app.whenReady().then(async () => {
    // Set app name for proper window class matching
    app.setName("CineSort");

    // Self-install desktop entry + icon on first launch (AppImage only)
    installDesktopEntry();

    startPython();

    try {
        await waitForServer();
    } catch (err) {
        console.error(err.message);
        app.quit();
        return;
    }

    const iconPath = getIconPath();
    console.log("[main] Icon path:", iconPath);
    const icon = iconPath ? nativeImage.createFromPath(iconPath) : null;

    mainWindow = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 900,
        minHeight: 500,
        title: "CineSort",
        icon: icon,
        backgroundColor: "#08080d",
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js"),
        },
    });
    
    // Try setting icon again after window creation
    if (icon && !icon.isEmpty()) {
        mainWindow.setIcon(icon);
    }

    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
});

app.on("window-all-closed", () => {
    if (pyProc) {
        pyProc.kill("SIGTERM");
    }
    app.quit();
});

app.on("before-quit", () => {
    if (pyProc) {
        pyProc.kill("SIGTERM");
    }
});
