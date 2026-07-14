const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, clipboard } = require("electron");
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

// ── Update download + install (desktop builds only) ───────────────────────────
// One click in Settings downloads the CORRECT package for this install —
// deb/rpm/AppImage × x64/arm64 — to ~/Downloads and verifies size + sha256.
// A second click installs it: deb/rpm through the system package manager under
// polkit authorization (the user approves in the OS's own dialog; apt/dnf do
// the actual install — we never run as root ourselves), AppImage by replacing
// the running file in place (user-owned, no privileges involved).
//
// Trust model: the renderer passes NO arguments to either step. Asset
// names/URLs/digests come from our own backend (/api/version → GitHub API),
// updater.js refuses non-GitHub download hosts, and update:install acts only
// on the file THIS process downloaded and verified (pendingUpdate) — re-hashed
// immediately before install, so a file swapped in ~/Downloads between the two
// clicks can never be escalated to the package manager.
const { pickAsset, downloadAsset, verifyFile } = require("./updater");

// Set only after a fully verified download; the sole thing update:install may act on.
let pendingUpdate = null;
let installInFlight = false;
// Set once an update is installed on disk and a restart would activate it.
// update:restart (renderer's "Restart CineSort" button) consumes it — the
// renderer never chooses HOW to restart, only WHETHER.
let pendingRestart = null;   // { mode: "relaunch" | "spawn", target?: string, latest: string }

// polkit's pkexec is how the user authorizes the package-manager step. Present
// on effectively every desktop distro; when absent we fall back to the old
// "here is the verified file + install command" flow instead of failing later.
function hasPkexec() {
    return ["/usr/bin/pkexec", "/usr/local/bin/pkexec", "/bin/pkexec"].some(p => fs.existsSync(p));
}

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

        // basename(): asset names come from our own GitHub release via the
        // backend, but a name is still external input — never let it steer
        // the write path out of ~/Downloads.
        const dest = path.join(app.getPath("downloads"), path.basename(asset.name));
        await downloadAsset(asset.url, dest, {
            expectedSize: asset.size,
            digest: asset.digest,
            // Object payload so the card can render byte counts; the renderer
            // also accepts a bare number from older mains.
            onProgress: (pct, transferred, total) =>
                evt.sender.send("update:download-progress", { pct, transferred, total }),
        });

        // AppImages must be executable; the app's own first-launch staging
        // (installDesktopEntry) takes over from there.
        if (pkgType === "appimage") fs.chmodSync(dest, 0o755);

        pendingUpdate = {
            file: dest,
            name: asset.name,
            pkgType,
            latest: info.update.latest,
            size: asset.size,
            digest: asset.digest,
        };

        // AppImage replace-in-place never needs privileges; deb/rpm need
        // pkexec for the authorized package-manager step. Without it, reveal
        // the verified file so the manual flow still works.
        const canInstall = pkgType === "appimage" || hasPkexec();
        if (!canInstall) shell.showItemInFolder(dest);
        return { ok: true, name: asset.name, file: dest, pkgType, latest: info.update.latest, canInstall };
    } catch (err) {
        console.error("[main] update download failed:", err.message);
        return { ok: false, error: err.message };
    }
});

// ── Update install ────────────────────────────────────────────────────────────
// Second click of the Settings button. Takes no renderer arguments by design
// (see trust model above).
ipcMain.handle("update:install", async () => {
    if (installInFlight) return { ok: false, error: "An install is already in progress." };
    if (!pendingUpdate) return { ok: false, error: "No verified update download to install. Download the update first." };
    installInFlight = true;
    const { file, name, pkgType, latest, size, digest } = pendingUpdate;
    try {
        // TOCTOU guard: re-verify against the release digest right before use.
        await verifyFile(file, { expectedSize: size, digest });

        if (pkgType === "appimage") {
            // Replace the file this install actually runs from ($APPIMAGE).
            // Copy-then-rename is atomic, so the menu entry never points at a
            // half-written image; the new version's first launch re-stages
            // ~/.local/bin and the desktop entry by itself. Unpackaged
            // fallback (no $APPIMAGE): just start the downloaded file.
            const target = process.env.APPIMAGE || file;
            if (target !== file) {
                const staged = target + ".new";
                fs.copyFileSync(file, staged);
                fs.chmodSync(staged, 0o755);
                fs.renameSync(staged, target);
            }
            pendingUpdate = null;
            // The renderer shows the themed "Start CineSort vX" prompt —
            // no native dialog (looked like an OS message, and "Restart now"
            // read like a system reboot).
            pendingRestart = { mode: "spawn", target, latest };
            if (mainWindow) {
                mainWindow.webContents.send("update:restart-pending",
                    { latest, running: app.getVersion(), mode: "spawn" });
            }
            return { ok: true, installed: true, pkgType, latest, restartPending: true };
        }

        // deb/rpm: the distro's own package manager does the install, under
        // polkit authorization. pkexec resolves the command on its hardened
        // PATH; the only argument we add is the re-verified absolute path.
        const cmd = pkgType === "deb"
            ? ["apt-get", "install", "-y", file]
            : fs.existsSync("/usr/bin/dnf")
            ? ["dnf", "install", "-y", file]
            : fs.existsSync("/usr/bin/zypper")
            ? ["zypper", "--non-interactive", "install", "--allow-unsigned-rpm", file]
            : ["rpm", "-U", file];

        const res = await new Promise((resolve, reject) => {
            const p = spawn("pkexec", cmd, { stdio: ["ignore", "ignore", "pipe"] });
            let err = "";
            p.stderr.on("data", d => { err += d; });
            p.on("error", reject);
            // Generous guard so a wedged dpkg/rpm lock can't hang the promise
            // forever; polkit's own auth dialog timeout is far shorter.
            const timer = setTimeout(() => {
                p.kill();
                reject(new Error("Install timed out after 10 minutes"));
            }, 10 * 60_000);
            p.on("exit", code => { clearTimeout(timer); resolve({ code, err: err.trim() }); });
        });

        // pkexec: 126 = user dismissed the auth dialog, 127 = not authorized.
        if (res.code === 126 || res.code === 127) {
            return { ok: false, cancelled: true, name, pkgType,
                     error: "Authorization was not granted — nothing was installed." };
        }
        if (res.code !== 0) {
            // Hand the user the verified file for a manual install.
            shell.showItemInFolder(file);
            const tail = res.err.split("\n").filter(Boolean).pop() || `exit ${res.code}`;
            return { ok: false, name, file, pkgType, error: `${cmd[0]} failed: ${tail}` };
        }

        pendingUpdate = null;
        // The focus/interval watcher would notice within a minute; fire the
        // familiar "Restart to finish" prompt right away instead.
        setImmediate(checkInstalledVersionChanged);
        return { ok: true, installed: true, pkgType, latest };
    } catch (err) {
        console.error("[main] update install failed:", err.message);
        return { ok: false, error: err.message, name, pkgType };
    } finally {
        installInFlight = false;
    }
});

// ── Update restart ────────────────────────────────────────────────────────────
// Consumes pendingRestart. Takes no renderer arguments: the renderer's
// "Restart CineSort" button only expresses consent — what actually happens
// (app.relaunch vs spawning the replaced AppImage) was decided when the
// install landed.
ipcMain.handle("update:restart", () => {
    if (!pendingRestart) return { ok: false, error: "No update awaiting a restart." };
    if (pendingRestart.mode === "spawn") {
        spawn(pendingRestart.target, [], {
            detached: true,
            stdio: "ignore",
            // extract-and-run works even where FUSE2 is unavailable
            // (same reason the .desktop entry sets it).
            env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
        }).unref();
    } else {
        app.relaunch();   // re-executes /opt/CineSort/cinesort — now the new build
    }
    app.quit();
    return { ok: true };
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

// ── Restart-to-finish-update prompt (deb/rpm) ─────────────────────────────────
// A package upgrade replaces /opt/CineSort under the RUNNING process: the old
// code keeps running until relaunch, which looks like "the update did
// nothing". Detect it by re-reading the installed package.json (fresh from
// disk) and comparing to the version this process started with; when they
// differ, offer a restart. Checked on window focus (the natural moment —
// the user just came back from the package manager) plus a slow timer.
// AppImage upgrades don't replace files under us (the instant-switch prompt
// in update:download covers them), but the check is harmless there too.
let updatePromptShown = false;

function installedVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(
            path.join(process.resourcesPath, "app", "package.json"), "utf8"));
        return pkg.version || null;
    } catch {
        // Dev run (no packaged resources) or a half-written file mid-upgrade —
        // try again on the next check.
        return null;
    }
}

function checkInstalledVersionChanged() {
    if (updatePromptShown || !mainWindow) return;
    const disk = installedVersion();
    if (!disk || disk === app.getVersion()) return;
    updatePromptShown = true;   // announce once per session; "Restart later" isn't nagged
    // Themed in-app prompt instead of a native dialog — the OS chrome made
    // "Restart now" read like a system reboot. The Settings update card keeps
    // a persistent restart affordance for anyone who dismissed the prompt.
    if (!pendingRestart) pendingRestart = { mode: "relaunch", latest: disk };
    mainWindow.webContents.send("update:restart-pending",
        { latest: disk, running: app.getVersion(), mode: "relaunch" });
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

// ── Backend log capture + crash recovery ─────────────────────────────────────
// Ring buffer of the backend's recent output. When startup fails or the
// backend keeps dying, the LAST lines are exactly what a bug report needs —
// today they only reach the terminal nobody launched the app from.
const PYLOG_MAX = 200;
const pyLog = [];
function pushPyLog(chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        pyLog.push(line);
        if (pyLog.length > PYLOG_MAX) pyLog.shift();
    }
}

let quitting = false;       // set on before-quit: an exiting backend is then expected
let currentPython = null;   // interpreter in use — needed to restart the backend
let lastCrashAt = 0;        // Date.now() of the previous unexpected backend exit
let recovering = false;     // a restart is in flight; don't stack a second one

/**
 * Unexpected backend exit while the window is open.
 * First crash (none in the last 60 s): restart it once, transparently —
 * covers one-off failures (OOM kill, a provider bug crashing uvicorn).
 * A second death within 60 s means restarting won't help; show the log and
 * offer Relaunch/Quit instead of leaving a dead UI.
 */
async function handleBackendExit() {
    if (quitting || !mainWindow) return;   // normal shutdown paths
    if (recovering) return;                // in-flight recovery surfaces the outcome
    recovering = true;
    try {
        const firstCrash = Date.now() - lastCrashAt > 60_000;
        lastCrashAt = Date.now();
        if (firstCrash && currentPython) {
            console.warn("[main] Backend exited unexpectedly — restarting it…");
            startPython(currentPython);
            await waitForServer(20_000);
            console.log("[main] Backend recovered.");
            if (mainWindow) mainWindow.reload();
            return;
        }
    } catch (err) {
        console.error("[main] Backend restart failed:", err.message);
    } finally {
        recovering = false;
    }

    // Repeated crash or failed restart — tell the user why, with the log.
    if (quitting || !mainWindow) return;
    const r = await dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "CineSort backend stopped",
        message: "The CineSort backend keeps stopping.",
        detail: "Last backend output:\n\n" + (pyLog.slice(-30).join("\n") || "(no output captured)"),
        buttons: ["Relaunch", "Quit"],
        defaultId: 0,
        cancelId: 1,
    });
    if (r.response === 0) {
        app.relaunch();
    }
    app.quit();
}

function startPython(python) {
    currentPython = python;
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

    pyProc.stdout.on("data", d => { console.log("[py]", d.toString().trim()); pushPyLog(d); });
    pyProc.stderr.on("data", d => { console.log("[py]", d.toString().trim()); pushPyLog(d); });
    pyProc.on("exit", (code) => {
        console.log(`[py] exited with code ${code}`);
        pyProc = null;
        handleBackendExit();   // no-op on normal quit (quitting / closed window)
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
        // Same UX family as the "Python not found" dialog: never vanish
        // silently — show WHY, and make the log one click away from a bug
        // report. (Missing dependency in a user-built venv is the classic
        // cause, seen live during v1.3.0 rpm testing on Fedora.)
        console.error(err.message);
        const r = await dialog.showMessageBox({
            type: "error",
            title: "CineSort could not start",
            message: "The backend server did not start.",
            detail: "Last backend output:\n\n" + (pyLog.slice(-30).join("\n") || "(no output captured)"),
            buttons: ["Copy details & Quit", "Quit"],
            defaultId: 0,
            cancelId: 1,
        });
        if (r.response === 0) {
            clipboard.writeText(pyLog.join("\n") || err.message);
        }
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

    // Restart-to-finish-update watcher (see checkInstalledVersionChanged).
    mainWindow.on("focus", checkInstalledVersionChanged);
    setInterval(checkInstalledVersionChanged, 60_000);
});

app.on("window-all-closed", () => {
    quitting = true;   // the backend's SIGTERM exit below is expected — no recovery
    if (pyProc) {
        pyProc.kill("SIGTERM");
    }
    app.quit();
});

app.on("before-quit", () => {
    quitting = true;
    if (pyProc) {
        pyProc.kill("SIGTERM");
    }
});
