const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require("electron");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const net = require("net");

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
    //
    // ── Black-window fix ──────────────────────────────────────────────────────
    // Under XWayland, GPU compositing produces an all-black window on many
    // Linux/Wayland setups (Intel + Wayland confirmed). The page itself renders
    // fine (verified via offscreen capturePage), so the failure is purely GPU
    // compositing to the on-screen surface. Disabling hardware acceleration
    // forces software compositing, which paints reliably everywhere — across
    // X11, XWayland, Intel/AMD/NVIDIA. This UI is lightweight (static panels +
    // CSS blur), so the CPU cost is negligible. Correctness for every machine
    // beats marginal GPU smoothness on the ones where it already worked.
    // Allow power users to opt back into GPU with CINESORT_ENABLE_GPU=1.
    if (process.env.CINESORT_ENABLE_GPU !== "1") {
        app.disableHardwareAcceleration();
        app.commandLine.appendSwitch("disable-gpu-compositing");
    }
}
// ─────────────────────────────────────────────────────────────────────────────

let pyProc = null;
let mainWindow = null;
// Preferred port, but resolved to an actually-free port at launch (see
// findFreePort). Hardcoding it meant a leftover/orphaned instance holding 47299
// (e.g. a not-fully-closed window or a stranded Python child) made every future
// launch fail with "address already in use" → the app appeared to "not launch".
let PORT = 47299;

/**
 * Resolve a free TCP port on 127.0.0.1. Tries the preferred port first; if it's
 * taken, asks the OS for an ephemeral free port (listen on 0). Guarantees a
 * fresh launch never collides with a stale instance.
 */
function findFreePort(preferred) {
    const tryListen = (p) => new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once("error", reject);
        srv.listen(p, "127.0.0.1", () => {
            const got = srv.address().port;
            srv.close(() => resolve(got));
        });
    });
    return tryListen(preferred).catch(() => tryListen(0));
}

// ── Native file/folder picker (desktop builds only) ───────────────────────────
// The renderer invokes this through the contextBridge `pickPaths()` API. It
// returns the chosen absolute paths (or [] when cancelled) and the renderer
// feeds them straight to the Python /api/scan-batch endpoint.
//
// Why this matters: /api/browse is intentionally restricted to mounted volumes
// (/mnt, /media) so the Docker server can't be walked over the network. The
// native OS picker bypasses that HTML browser entirely for deb/AppImage, letting
// desktop users reach $HOME and any mount/share while the OS file permissions —
// not an app-level allow-list — remain the security boundary. Docker (no
// Electron) never sees this handler and keeps using the restricted HTML browser.
//
// `properties` is clamped to a known-safe whitelist so a compromised renderer
// can only ever open a user-driven picker, never change its semantics.
const ALLOWED_PICKER_PROPS = new Set([
    "openFile", "openDirectory", "multiSelections", "showHiddenFiles", "createDirectory",
]);
ipcMain.handle("dialog:open", async (_evt, opts = {}) => {
    const requested = Array.isArray(opts.properties) ? opts.properties : [];
    let properties = requested.filter(p => ALLOWED_PICKER_PROPS.has(p));
    if (properties.length === 0) {
        // Sensible default: multi-select folders, hidden files visible.
        properties = ["openDirectory", "multiSelections", "showHiddenFiles"];
    }
    const options = { properties };
    const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
});

// Reveal a file/folder in the OS file manager (desktop builds only). The
// renderer already knows the path (it scanned it), so this exposes no new
// information; it only asks the OS to open its file manager at that location.
ipcMain.handle("shell:showItem", (_evt, fullPath) => {
    if (typeof fullPath !== "string" || !fullPath) return false;
    shell.showItemInFolder(fullPath);
    return true;
});

// ── Update download (desktop builds only) ─────────────────────────────────────
// One click in Settings downloads the CORRECT package for this install —
// deb/rpm/AppImage × x64/arm64 — to ~/Downloads, verifies size + sha256, and
// reveals it in the file manager. Deliberately NOT auto-installing: deb/rpm
// need root, and prompting for privilege escalation from an auto-updater is a
// worse security posture than handing the user a verified file.
//
// Trust model: the renderer passes NO arguments. Asset names/URLs/digests come
// from our own backend (/api/version → GitHub API), and updater.js refuses
// non-GitHub download hosts — a compromised renderer can trigger a download
// but can never choose what or from where.
const { pickAsset, downloadAsset } = require("./updater");

function detectPackageType() {
    // AppImage runtime always sets $APPIMAGE (see installDesktopEntry below).
    if (process.env.APPIMAGE) return "appimage";
    // deb/rpm installs register the "cinesort" package with their manager.
    try { execFileSync("dpkg", ["-s", "cinesort"], { stdio: "ignore" }); return "deb"; } catch {}
    try { execFileSync("rpm", ["-q", "cinesort"], { stdio: "ignore" }); return "rpm"; } catch {}
    // Unpackaged (dev run, manual extract): AppImage is the universal fallback.
    return "appimage";
}

ipcMain.handle("update:download", async (evt) => {
    try {
        // Ask our own backend (cached GitHub check) — never the renderer.
        const info = await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${PORT}/api/version`, res => {
                let body = "";
                res.on("data", d => { body += d; });
                res.on("end", () => {
                    try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
                });
            }).on("error", reject);
        });
        if (!info || !info.update) return { ok: false, error: "No update available." };

        const pkgType = detectPackageType();
        const arch = process.arch === "arm64" ? "arm64" : "x64";
        const asset = pickAsset(info.update.assets || [], pkgType, arch);
        if (!asset) {
            return { ok: false, error: `Release v${info.update.latest} has no ${pkgType} package for ${arch}.` };
        }

        const dest = path.join(app.getPath("downloads"), asset.name);
        await downloadAsset(asset.url, dest, {
            expectedSize: asset.size,
            digest: asset.digest,
            onProgress: pct => evt.sender.send("update:download-progress", pct),
        });

        // AppImages must be executable; the app's own first-launch staging
        // (installDesktopEntry) takes over from there.
        if (pkgType === "appimage") fs.chmodSync(dest, 0o755);

        shell.showItemInFolder(dest);
        return { ok: true, name: asset.name, file: dest, pkgType, latest: info.update.latest };
    } catch (err) {
        console.error("[main] update download failed:", err.message);
        return { ok: false, error: err.message };
    }
});
// ─────────────────────────────────────────────────────────────────────────────

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

// ── Python version constants ──────────────────────────────────────────────────
const PYTHON_MIN_MINOR = 9;   // require Python >= 3.9
const PYTHON_SEARCH_PREFIXES = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];

// ── Python discovery helpers ──────────────────────────────────────────────────

/**
 * Read the Python minor version the bundled venv was built for.
 * Inspects the venv/lib/pythonX.Y directory name.
 * Returns e.g. { major: 3, minor: 12 } or null.
 */
function readVenvPythonVersion(venvDir) {
    const libDir = path.join(venvDir, "lib");
    try {
        for (const entry of fs.readdirSync(libDir)) {
            const m = entry.match(/^python(\d+)\.(\d+)$/);
            if (m) return { major: parseInt(m[1]), minor: parseInt(m[2]) };
        }
    } catch {}
    return null;
}

/**
 * Find a system Python binary.
 * @param {number|null} preferMinor - Prefer this minor version (exact match).
 * Returns { path, major, minor } or null.
 */
function probeSystemPython(preferMinor = null) {
    // Try exact match first
    if (preferMinor !== null) {
        for (const pre of PYTHON_SEARCH_PREFIXES) {
            const p = path.join(pre, `python3.${preferMinor}`);
            if (fs.existsSync(p)) return { path: p, major: 3, minor: preferMinor };
        }
    }
    // Try any compatible version, newest first
    for (let minor = 20; minor >= PYTHON_MIN_MINOR; minor--) {
        for (const pre of PYTHON_SEARCH_PREFIXES) {
            const p = path.join(pre, `python3.${minor}`);
            if (fs.existsSync(p)) return { path: p, major: 3, minor };
        }
    }
    return null;
}

/**
 * Repair the broken symlinks inside the bundled venv and rewrite pyvenv.cfg
 * to point to `sysPyPath`.  Only call when the discovered system Python version
 * exactly matches the venv's built-for version.
 */
function fixVenvSymlinks(venvDir, venvVer, sysPyPath) {
    const binDir = path.join(venvDir, "bin");
    const venvPy = path.join(binDir, "python3");
    const venvPyVer = path.join(binDir, `python${venvVer.major}.${venvVer.minor}`);

    try {
        // Atomic replace: write to .tmp then rename
        for (const link of [venvPy, venvPyVer]) {
            const tmp = link + ".tmp";
            if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
            fs.symlinkSync(sysPyPath, tmp);
            fs.renameSync(tmp, link);
        }

        // Also patch pyvenv.cfg so `python3 -m venv --upgrade` works later
        const cfgPath = path.join(venvDir, "pyvenv.cfg");
        if (fs.existsSync(cfgPath)) {
            let cfg = fs.readFileSync(cfgPath, "utf8");
            cfg = cfg.replace(/^home\s*=.*$/m, `home = ${path.dirname(sysPyPath)}`);
            fs.writeFileSync(cfgPath, cfg);
        }

        console.log(`[main] Repaired venv symlinks → ${sysPyPath}`);
        return true;
    } catch (e) {
        console.warn("[main] Could not repair venv symlinks:", e.message);
        return false;
    }
}

/**
 * Run a command and return stdout.  Rejects on non-zero exit.
 */
function runCmd(cmd, args) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const errChunks = [];
        const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
        proc.stdout.on("data", d => chunks.push(d));
        proc.stderr.on("data", d => errChunks.push(d));
        proc.on("exit", code => {
            if (code === 0) resolve(Buffer.concat(chunks).toString());
            else reject(new Error(`${path.basename(cmd)} exited ${code}: ${Buffer.concat(errChunks).toString().trim()}`));
        });
    });
}

/**
 * Create (or verify) a user-local venv at ~/.local/share/cinesort/venv
 * using `sysPyPath` and install from the bundled requirements.txt.
 * Returns the path to the venv's python3, or null on failure.
 */
async function ensureUserVenv(sysPyPath) {
    const userVenvDir = path.join(os.homedir(), ".local", "share", "cinesort", "venv");
    const userPython  = path.join(userVenvDir, "bin", "python3");

    // Check if an existing user venv is still healthy
    if (fs.existsSync(userPython)) {
        try {
            const real = fs.realpathSync(userPython);
            if (fs.existsSync(real)) {
                console.log(`[main] User venv OK: ${real}`);
                return userPython;
            }
        } catch {}
        console.warn("[main] User venv is stale, rebuilding...");
    }

    const reqFile = path.join(process.resourcesPath, "requirements.txt");
    if (!fs.existsSync(reqFile)) {
        console.error("[main] requirements.txt not found in resources — cannot build user venv");
        return null;
    }

    try {
        console.log(`[main] Building user venv at ${userVenvDir} with ${sysPyPath}…`);
        fs.mkdirSync(path.dirname(userVenvDir), { recursive: true });
        await runCmd(sysPyPath, ["-m", "venv", "--clear", userVenvDir]);
        const pip = path.join(userVenvDir, "bin", "pip");
        await runCmd(pip, ["install", "--quiet", "-r", reqFile]);
        console.log("[main] User venv ready.");
        return userPython;
    } catch (e) {
        console.error("[main] Failed to build user venv:", e.message);
        return null;
    }
}

/**
 * Verify a venv python can actually run the app: the interpreter executes AND
 * the compiled C extensions import. Catches two arm64 failure modes the plain
 * symlink check misses: (a) an x64 python binary on an arm64 host (ENOEXEC),
 * and (b) a WORKING system-python symlink whose venv still carries the build
 * machine's x86_64 .so files (pydantic-core etc. → ImportError). Without this
 * probe both the fast path and the symlink repair "succeed" on arm64 and the
 * server then dies at startup — spinner, timeout, no window.
 */
function probeVenv(pythonPath) {
    try {
        execFileSync(pythonPath, ["-c", "import pydantic_core, uvicorn, httpx"], {
            stdio: "ignore",
            timeout: 15000,
        });
        return true;
    } catch (e) {
        console.warn(`[main] venv probe failed for ${pythonPath}: ${e.message}`);
        return false;
    }
}

/**
 * Locate or repair the Python interpreter to use.
 *
 * Strategy (in order):
 *   1. Bundled venv symlink valid AND probe passes → use it (fast path).
 *   2. Broken/unprobeable + system has EXACT same minor version
 *      → repair symlinks (no network, instant), re-probe.
 *   3. Still unusable (different version, or foreign-arch .so files)
 *      → build a user venv in ~/.local/share/cinesort/venv (one-time pip
 *        install — needs network; this is the normal first launch on arm64).
 *   4. Dev mode → use .venv in project root.
 *
 * Returns { python: string, firstRun: boolean }
 */
async function findOrCreatePython() {
    const venvDir = path.join(process.resourcesPath, "venv");
    const isPackaged = fs.existsSync(venvDir);

    if (!isPackaged) {
        // Development mode
        return { python: path.join(__dirname, "..", ".venv", "bin", "python3"), firstRun: false };
    }

    const venvPython = path.join(venvDir, "bin", "python3");

    // ── Fast path: bundled venv symlink is valid AND actually runs ────────────
    try {
        const real = fs.realpathSync(venvPython);
        if (fs.existsSync(real) && probeVenv(venvPython)) {
            console.log(`[main] Bundled venv OK: ${real}`);
            return { python: venvPython, firstRun: false };
        }
    } catch {}

    console.warn("[main] Bundled venv is broken or wrong-arch — attempting repair…");

    const venvVer = readVenvPythonVersion(venvDir);
    const preferMinor = venvVer ? venvVer.minor : null;
    const sysPy = probeSystemPython(preferMinor);

    if (!sysPy) {
        await dialog.showMessageBox({
            type: "error",
            title: "Python not found",
            message: "CineSort requires Python 3.9 or later.",
            detail:
                "No compatible Python installation was found on this system.\n\n" +
                "Install Python 3.9+ from your distribution's package manager:\n" +
                "  sudo apt install python3        (Debian / Ubuntu)\n" +
                "  sudo dnf install python3        (Fedora / RHEL)\n\n" +
                "Then relaunch CineSort.",
            buttons: ["Quit"],
        });
        app.quit();
        return { python: null, firstRun: false };
    }

    // ── Repair path: system Python matches the venv's built-for version ───────
    // Re-probe after the repair: on arm64 the symlink fix "succeeds" but the
    // bundled x86_64 .so files still can't import — fall through to user venv.
    if (venvVer && sysPy.minor === venvVer.minor) {
        if (fixVenvSymlinks(venvDir, venvVer, sysPy.path) && probeVenv(venvPython)) {
            return { python: venvPython, firstRun: false };
        }
        // repair failed or venv still unusable (foreign arch) — user venv below
    }

    // ── Rebuild path: different version → create user venv ───────────────────
    // The C extensions in the bundled venv (pydantic-core, uvloop, httptools)
    // are compiled for Python ${venvVer?.minor ?? '?'}, so we cannot reuse them
    // with a different minor version.  Build a fresh venv instead.
    if (venvVer) {
        console.warn(
            `[main] System Python 3.${sysPy.minor} ≠ bundled venv Python 3.${venvVer.minor} — ` +
            `building user venv with system Python…`
        );
    }

    const userPython = await ensureUserVenv(sysPy.path);
    if (!userPython) {
        await dialog.showMessageBox({
            type: "error",
            title: "Setup failed",
            message: "CineSort could not set up its Python environment.",
            detail:
                `Python ${sysPy.minor} was found at ${sysPy.path} but installing ` +
                "the required packages failed.\n\n" +
                "Check your internet connection and try relaunching CineSort.\n" +
                "If the problem persists, run:\n" +
                `  python3 -m venv ~/.local/share/cinesort/venv\n` +
                `  ~/.local/share/cinesort/venv/bin/pip install fastapi uvicorn httpx pydantic`,
            buttons: ["Quit"],
        });
        app.quit();
        return { python: null, firstRun: false };
    }

    return { python: userPython, firstRun: true };
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

function startPython(python) {
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
                if (["TMDB_API_KEY", "OMDB_API_KEY", "TMDB_LANGUAGE"].includes(key) && !(key in childEnv) && value) {
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

    const homeDir = os.homedir();
    const appsDir = path.join(homeDir, ".local", "share", "applications");
    const desktopFile = path.join(appsDir, "cinesort.desktop");

    // ── Don't shadow a system (deb/rpm) install ──────────────────────────────
    // A user-local .desktop in ~/.local/share/applications takes PRIORITY over
    // /usr/share/applications. If the deb is installed and we also register our
    // own entry, ours overrides the deb's — and if this AppImage is later moved
    // or deleted, the menu launcher runs a dead path (spinner, no window). So
    // when a system install is present we step aside, and we clean up any stale
    // entry a previous AppImage run may have left behind.
    const systemInstalled = fs.existsSync("/usr/share/applications/cinesort.desktop")
                         || fs.existsSync("/opt/CineSort/cinesort");
    if (systemInstalled) {
        try {
            if (fs.existsSync(desktopFile)) {
                fs.unlinkSync(desktopFile);
                try { execFileSync("update-desktop-database", [appsDir]); } catch {}
                console.log("[main] Removed stale AppImage desktop entry (system install present).");
            }
        } catch (e) {
            console.warn("[main] Could not remove stale desktop entry:", e.message);
        }
        console.log("[main] System (deb) install detected — skipping AppImage self-registration to avoid shadowing it.");
        return;
    }

    try {
        const iconsDir = path.join(homeDir, ".local", "share", "icons", "hicolor", "512x512", "apps");

        // ── Stable launcher path ─────────────────────────────────────────────
        // Point Exec at a copy in ~/.local/bin instead of wherever the AppImage
        // was double-clicked from, so moving/deleting the original file doesn't
        // break the menu entry (a common "won't launch" cause).
        const runningPath = process.env.APPIMAGE || process.execPath;
        const binDir = path.join(homeDir, ".local", "bin");
        const stablePath = path.join(binDir, "CineSort.AppImage");
        let appImagePath = runningPath;
        try {
            if (runningPath !== stablePath) {
                fs.mkdirSync(binDir, { recursive: true });
                const cur = fs.statSync(runningPath);
                const have = fs.existsSync(stablePath) ? fs.statSync(stablePath) : null;
                if (!have || have.size !== cur.size) {
                    fs.copyFileSync(runningPath, stablePath);
                    fs.chmodSync(stablePath, 0o755);
                    console.log(`[main] Staged AppImage to stable path: ${stablePath}`);
                }
                appImagePath = stablePath;
            }
        } catch (e) {
            console.warn("[main] Could not stage AppImage to ~/.local/bin; using original path:", e.message);
            appImagePath = runningPath;
        }

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

    // Resolve a free port BEFORE starting Python so a stale instance holding
    // 47299 can never block this launch.
    PORT = await findFreePort(47299);
    console.log(`[main] Using port ${PORT}`);

    // Resolve Python — repairs broken venv symlinks or builds a user venv as
    // needed.  Must complete before startPython() is called.
    const { python, firstRun } = await findOrCreatePython();
    if (!python) return;  // dialog shown + app.quit() already called

    startPython(python);

    // Allow more time on the very first launch (user venv pip install already
    // completed, but uvicorn cold-start with freshly installed packages is slower).
    const serverTimeout = firstRun ? 60_000 : 20_000;

    try {
        await waitForServer(serverTimeout);
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
        backgroundColor: "#0a0a0b",
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
