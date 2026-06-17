/* ═══════════════════════════════════════════════════════════════
   Media Renamer — Frontend Application
   Dual-pane layout: Original files ↔ New names
   ═══════════════════════════════════════════════════════════════ */

(() => {
"use strict";

/* ─── State ───────────────────────────────────────────────── */
let scannedFiles = [];   // raw from /api/scan
let matchResults = [];   // raw from /api/match
let selectedSet = new Set(); // indices in scannedFiles that are checked
const isElectron = !!(window.electronAPI && window.electronAPI.isElectron);
const canShowInFolder = isElectron && typeof window.electronAPI.showInFolder === "function";
let draggedIdx = null;   // index being dragged
let draggedFrom = null;  // 'left' or 'right'
let focusedIdx = null;   // keyboard-focused row (DEL/arrow navigation)

// Matches at/below this confidence are flagged "needs review" and are NOT
// auto-selected for renaming — the user must opt in. Mirrors the backend's
// LOW_CONFIDENCE_THRESHOLD so all build targets behave identically.
const LOW_CONFIDENCE = 0.4;

/* Deselect weak auto-matches so a low-confidence guess can't be renamed by
   default. Manual names and confident matches keep their selection. */
function applyConfidenceGate() {
    for (let i = 0; i < matchResults.length; i++) {
        const m = matchResults[i];
        if (m && m.matched && !m.manual && m.score < LOW_CONFIDENCE) {
            selectedSet.delete(i);
        }
    }
}

/* ─── DOM refs ────────────────────────────────────────────── */
const $ = s => document.querySelector(s);
const $id = s => document.getElementById(s);

const elScanPath    = $id("scan-path");
const elRecursive   = $id("recursive");
const elTemplate    = $id("template");
const elSource      = $id("datasource");
const elAction      = $id("action");
const elIncludeAdult = $id("include-adult");

const btnScan   = $id("btn-scan");
const btnBrowse = $id("btn-browse");
const btnMatch  = $id("btn-match");
const btnRename = $id("btn-rename");
const btnHistory = $id("btn-history");

const leftList   = $id("left-list");
const rightList  = $id("right-list");
const gutter     = $id("gutter");
const leftCount  = $id("left-count");
const rightCount = $id("right-count");

const statusBar  = $id("status-bar");
const statusText = $id("status-text");
const progressFill = $id("progress-fill");

const modalOverlay = $id("modal-overlay");
const modalTitle   = $id("modal-title");
const modalBody    = $id("modal-body");
const modalClose   = $id("modal-close");

const keyBanner        = $id("key-banner");
const bannerOpenSettings = $id("banner-open-settings");
const bannerDismiss    = $id("banner-dismiss");

/* ─── First-run key check ─────────────────────────────────── */
(async function checkKeysOnStartup() {
    try {
        const s = await api("/api/settings");
        if (!s.tmdb_enabled) {
            keyBanner.classList.remove("hidden");
        }
    } catch {
        // Non-fatal — banner stays hidden if the request fails
    }
})();

bannerOpenSettings.addEventListener("click", () => {
    keyBanner.classList.add("hidden");
    showSettings();
});
bannerDismiss.addEventListener("click", () => keyBanner.classList.add("hidden"));

/* ─── Helpers ─────────────────────────────────────────────── */
function status(msg, pct) {
    statusBar.classList.remove("hidden");
    statusText.textContent = msg;
    progressFill.classList.remove("loading");
    if (pct === undefined) {
        progressFill.classList.add("loading");
    } else {
        progressFill.style.width = pct + "%";
    }
}
function statusDone(msg) {
    statusText.textContent = msg;
    progressFill.classList.remove("loading");
    progressFill.style.width = "100%";
    setTimeout(() => { statusBar.classList.add("hidden"); }, 2500);
}
function statusHide() { statusBar.classList.add("hidden"); }

function fmt(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes/1024).toFixed(1) + " KB";
    if (bytes < 1073741824) return (bytes/1048576).toFixed(1) + " MB";
    return (bytes/1073741824).toFixed(2) + " GB";
}

async function api(url, opts = {}) {
    const res = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...opts,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || err.message || res.statusText);
    }
    return res.json();
}

/* ─── Prevent browser from opening dropped files ──────────── */
document.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); });
document.addEventListener("dragenter", e => { e.preventDefault(); e.stopPropagation(); });
document.addEventListener("drop", e => { e.preventDefault(); e.stopPropagation(); });

/* ─── Drag & Drop on left pane ────────────────────────────── */
let dragCounter = 0;
const dropTarget = $id("pane-left");

dropTarget.addEventListener("dragenter", e => {
    e.preventDefault();
    dragCounter++;
    const dz = $id("drop-zone");
    if (dz) dz.classList.add("drag-hover");
    document.body.classList.add("dragging-over");
});
dropTarget.addEventListener("dragleave", e => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
        dragCounter = 0;
        const dz = $id("drop-zone");
        if (dz) dz.classList.remove("drag-hover");
        document.body.classList.remove("dragging-over");
    }
});
dropTarget.addEventListener("dragover", e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
});
dropTarget.addEventListener("drop", e => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    const dz = $id("drop-zone");
    if (dz) dz.classList.remove("drag-hover");
    document.body.classList.remove("dragging-over");

    const files = Array.from(e.dataTransfer.files || []);

    // ── Electron: webUtils.getPathForFile gives full filesystem path ──
    if (window.electronAPI && window.electronAPI.getPathForFile && files.length > 0) {
        try {
            const paths = files
                .map(f => window.electronAPI.getPathForFile(f))
                .filter(p => p && p.length > 0);
            if (paths.length > 0) {
                handleDroppedPaths(paths);
                return;
            }
        } catch (ex) {
            console.warn("electronAPI.getPathForFile failed:", ex);
        }
    }

    // ── Also try legacy file.path (older Electron) ──
    if (files.length > 0 && files[0].path) {
        const paths = files.map(f => f.path).filter(Boolean);
        if (paths.length > 0) {
            handleDroppedPaths(paths);
            return;
        }
    }

    // ── Browser: try file:// URIs from data transfer ──
    let paths = [];
    for (const t of e.dataTransfer.types) {
        const data = e.dataTransfer.getData(t);
        if (data && data.includes("file://")) {
            paths = data
                .split(/\r?\n/)
                .filter(l => l.trim().startsWith("file://"))
                .map(u => decodeURIComponent(u.trim().replace(/^file:\/\//, "")));
            if (paths.length > 0) break;
        }
    }

    if (paths.length > 0) {
        handleDroppedPaths(paths);
        return;
    }

    // ── Fallback: ask user for the folder ──
    if (files.length > 0) {
        showLocateDialog(files.map(f => f.name));
    }
});

function showLocateDialog(filenames) {
    modalTitle.textContent = "Locate Files";
    const nameList = filenames.slice(0, 5).map(n => `<code>${esc(n)}</code>`).join("<br>");
    const more = filenames.length > 5 ? `<br><span style="color:var(--txt3)">…and ${filenames.length - 5} more</span>` : "";
    modalBody.innerHTML = `
        <p style="color:var(--txt2);margin-bottom:10px">
            Dropped <strong>${filenames.length}</strong> file(s):
        </p>
        <div style="margin-bottom:14px;font-size:11px;line-height:1.6;color:var(--txt3)">${nameList}${more}</div>
        <p style="color:var(--txt2);margin-bottom:8px">
            Enter the folder containing these files:
        </p>
        <div style="display:flex;gap:6px">
            <input type="text" id="locate-path" class="glass-input mono" style="flex:1;font-size:12px"
                   placeholder="/path/to/folder" spellcheck="false" value="${esc(elScanPath.value)}">
            <button class="glass-btn btn-scan" id="locate-go">Scan</button>
        </div>
        <p style="color:var(--txt3);font-size:10px;margin-top:8px">
            The browser can't read full file paths for security reasons.
        </p>`;
    modalOverlay.classList.remove("hidden");

    const locateInput = $id("locate-path");
    const locateGo = $id("locate-go");
    locateInput.focus();
    setTimeout(() => locateInput.select(), 50);

    async function go() {
        const dir = locateInput.value.trim();
        if (!dir) { locateInput.focus(); return; }

        // Build full paths: dir + each filename
        const fullPaths = filenames.map(name => dir.replace(/\/$/, "") + "/" + name);
        modalOverlay.classList.add("hidden");

        // Also set the scan path for convenience
        elScanPath.value = dir;

        // Use batch scan endpoint
        status("Scanning dropped files…");
        try {
            const data = await api("/api/scan-batch", {
                method: "POST",
                body: JSON.stringify({ paths: fullPaths }),
            });
            scannedFiles = data.files;
            matchResults = [];
            selectedSet = new Set(scannedFiles.map((_, i) => i));
            renderLeft();
            renderRight();
            renderGutter();
            btnMatch.disabled = scannedFiles.length === 0;
            btnRename.disabled = true;
            statusDone(`Found ${scannedFiles.length} media file(s)`);
        } catch (err) {
            statusDone("Scan failed: " + err.message);
        }
    }

    locateGo.addEventListener("click", go);
    locateInput.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
}

function showSelectionDialog(groupName, candidates, filesToMatch) {
    modalTitle.textContent = "Select best match for \"" + groupName + "\"";
    
    let html = `<p style="color:var(--txt2);margin-bottom:12px;font-size:12px">Multiple matches found. Select the correct show:</p>`;
    html += `<div class="candidate-list">`;
    
    for (const c of candidates) {
        const year = c.year ? ` (${c.year})` : "";
        const rating = c.rating ? ` ⭐ ${c.rating.toFixed(1)}` : "";
        const poster = c.poster ? `<img src="${esc(c.poster)}" style="width:40px;height:60px;object-fit:cover;border-radius:4px;">` : 
                                   `<div style="width:40px;height:60px;background:var(--glass-hover);border-radius:4px;"></div>`;
        const overview = c.overview ? `<div style="font-size:10px;color:var(--txt3);margin-top:4px;line-height:1.4">${esc(c.overview)}</div>` : "";
        
        html += `<div class="candidate-item" data-id="${c.id}" data-name="${esc(c.name)}">
            ${poster}
            <div style="flex:1;min-width:0;">
                <div style="font-weight:500;font-size:12px;color:var(--txt)">${esc(c.name)}${year}${rating}</div>
                ${overview}
            </div>
            <button class="glass-btn btn-scan" onclick="R.selectShow(${c.id}, '${esc(c.name).replace(/'/g, "\\'")}', event)" style="padding:4px 12px;font-size:11px">Select</button>
        </div>`;
    }
    
    html += `</div>`;
    html += `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:flex;gap:8px">
        <button class="glass-btn" onclick="R.closeModal()" style="flex:1">Cancel</button>
    </div>`;
    
    modalBody.innerHTML = html;
    modalOverlay.classList.remove("hidden");

    // Store filesToMatch for the selection callback
    window._pendingMatchFiles = filesToMatch;
}

/* ─── Themed confirm dialog (replaces native confirm() for theme consistency) ──
   Uses its own overlay so it can stack above an already-open modal (e.g. the
   History modal). Returns a Promise<boolean>. */
function confirmDialog(message, { okText = "OK", cancelText = "Cancel", danger = false } = {}) {
    return new Promise(resolve => {
        let overlay = $id("confirm-overlay");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = "confirm-overlay";
            overlay.className = "confirm-overlay hidden";
            document.body.appendChild(overlay);
        }
        overlay.innerHTML = `
            <div class="glass-panel confirm-box">
                <p class="confirm-msg"></p>
                <div class="confirm-actions">
                    <button class="glass-btn" id="confirm-cancel">${esc(cancelText)}</button>
                    <button class="glass-btn ${danger ? "btn-danger" : "btn-scan"}" id="confirm-ok">${esc(okText)}</button>
                </div>
            </div>`;
        overlay.querySelector(".confirm-msg").textContent = message;   // textContent = no HTML injection
        overlay.classList.remove("hidden");

        const finish = (val) => {
            overlay.classList.add("hidden");
            document.removeEventListener("keydown", onKey, true);
            resolve(val);
        };
        const onKey = (e) => {
            // Capture phase + stopPropagation so Enter/Esc don't leak to the
            // document-level shortcuts (which would close the modal behind us).
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
            else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(true); }
        };
        $id("confirm-ok").addEventListener("click", () => finish(true));
        $id("confirm-cancel").addEventListener("click", () => finish(false));
        overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(false); });
        document.addEventListener("keydown", onKey, true);
        $id("confirm-ok").focus();
    });
}

// Active conflicts being resolved in the dialog. Each conflict gets a
// normalised `_origs` array (the source file(s) involved) so the inline
// Skip / Rename-to-(2) buttons can reference them by index.
let _activeConflicts = [];

function _findIdxByOriginal(origPath) {
    return scannedFiles.findIndex(f => f && f.path === origPath);
}

function _bumpFilename(name) {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) + " (2)" + name.slice(dot) : name + " (2)";
}

function showConflictsDialog(conflicts) {
    _activeConflicts = conflicts.map(c => ({
        ...c,
        _origs: c.type === "duplicate_destination" ? (c.files || []) : (c.file ? [c.file] : []),
    }));
    renderConflictsDialog();
}

function renderConflictsDialog() {
    modalTitle.textContent = "⚠️ Rename Conflicts";

    if (_activeConflicts.length === 0) {
        modalBody.innerHTML = `<div style="text-align:center;padding:24px;color:var(--green);font-size:13px">✓ All conflicts resolved</div>
            <button class="glass-btn btn-scan" onclick="R.closeModal()" style="width:100%;margin-top:8px">Done</button>`;
        return;
    }

    let html = `<p style="color:var(--txt2);margin-bottom:12px;font-size:12px">${_activeConflicts.length} conflict(s) remaining. Resolve each below:</p>`;
    html += `<div style="max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:8px">`;

    _activeConflicts.forEach((c, ci) => {
        const isDup = c.type === "duplicate_destination";
        const accent = isDup ? "255,180,0" : "255,60,60";
        const icon = isDup ? "⚠ Duplicate Destination" : "⛔ File Exists";
        html += `<div style="padding:10px;background:rgba(${accent},0.1);border:1px solid rgba(${accent},0.3);border-radius:6px">`;
        html += `<div style="font-weight:500;font-size:11px;color:rgb(${accent});margin-bottom:4px">${icon}</div>`;
        html += `<div style="font-size:10px;color:var(--txt2);margin-bottom:6px">${esc(c.message)}</div>`;
        // One action row per involved source file
        c._origs.forEach((orig, j) => {
            const idx = _findIdxByOriginal(orig);
            const known = idx >= 0;
            html += `<div style="display:flex;align-items:center;gap:6px;margin-top:4px">`;
            html += `<span style="flex:1;font-size:10px;color:var(--txt3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(Path.basename(orig))}</span>`;
            if (known) {
                html += `<button class="glass-btn" style="font-size:10px;padding:3px 8px" onclick="R.conflictBump(${ci},${j})">Rename → (2)</button>`;
                html += `<button class="glass-btn" style="font-size:10px;padding:3px 8px" onclick="R.conflictSkip(${ci},${j})">Skip</button>`;
            } else {
                html += `<span style="font-size:10px;color:var(--txt3)">(not in list)</span>`;
            }
            html += `</div>`;
        });
        html += `</div>`;
    });

    html += `</div>`;
    html += `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">`;
    html += `<p style="font-size:10px;color:var(--txt3);margin-bottom:8px">Skip removes the file from the rename selection. Rename → (2) appends " (2)" to the new name.</p>`;
    html += `<button class="glass-btn" onclick="R.closeModal()" style="width:100%">Close</button>`;
    html += `</div>`;

    modalBody.innerHTML = html;
    modalOverlay.classList.remove("hidden");
}

async function handleDroppedPaths(paths) {
    status("Scanning dropped files…");

    // If a single directory was dropped, scan it
    // If multiple files, scan each one individually
    // We'll try scanning the first path as a directory first
    try {
        // If it's a single folder
        if (paths.length === 1) {
            const data = await api("/api/scan", {
                method: "POST",
                body: JSON.stringify({ path: paths[0], recursive: elRecursive.checked }),
            });
            scannedFiles = data.files;
        } else {
            // Multiple files — scan each parent dir? Or scan individually
            // Actually send them one by one to scan (which handles single files)
            const allFiles = [];
            for (const p of paths) {
                try {
                    const data = await api("/api/scan", {
                        method: "POST",
                        body: JSON.stringify({ path: p, recursive: false }),
                    });
                    allFiles.push(...data.files);
                } catch { /* skip non-media files */ }
            }
            scannedFiles = allFiles;
        }

        matchResults = [];
        selectedSet = new Set(scannedFiles.map((_, i) => i));
        renderLeft();
        renderRight();
        renderGutter();
        btnMatch.disabled = scannedFiles.length === 0;
        btnRename.disabled = true;
        statusDone(`Found ${scannedFiles.length} media file(s)`);
    } catch (err) {
        statusDone("Drop failed: " + err.message);
    }
}

function showNotice(msg) {
    modalTitle.textContent = "Notice";
    modalBody.innerHTML = `<p style="white-space:pre-wrap;color:var(--txt2)">${esc(msg)}</p>`;
    modalOverlay.classList.remove("hidden");
}

// Helper: Path utilities
const Path = {
    basename(path) {
        return path.split('/').pop().split('\\').pop();
    }
};

function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
}

/* ─── Action hint banner ──────────────────────────────────── */
const ACTION_HINTS = {
    rename:   "Rename (in-place): only the filename changes — files stay in their current folder. Works on NAS/SMB. No new folders are created.",
    test:     "Test (Dry Run): nothing is changed on disk. Preview results only.",
    move:     "Move: files are moved to a new path built from the template. Source file is deleted. New folders are created as needed.",
    copy:     "Copy: a renamed copy is placed in the new path. Original file is kept.",
    hardlink: "Hard Link: a directory entry that shares the same data blocks. Both names refer to the same file. Same filesystem required.",
    symlink:  "Symlink: a symbolic link placed at the new path pointing back to the original. Not supported on SMB/CIFS or FAT/exFAT.",
};

const elActionHint = (() => {
    const el = document.createElement("div");
    el.id = "action-hint";
    el.className = "action-hint hidden";
    // Insert below the scanbar, above the dual-pane
    const statusBar = $id("status-bar");
    statusBar.parentNode.insertBefore(el, statusBar.nextSibling);
    return el;
})();

function updateActionHint() {
    const hint = ACTION_HINTS[elAction.value];
    if (hint) {
        elActionHint.textContent = hint;
        elActionHint.className = "action-hint action-hint-" + elAction.value;
    } else {
        elActionHint.className = "action-hint hidden";
    }
}

elAction.addEventListener("change", () => {
    updateActionHint();
    persistPrefs();
    // Refresh the right pane so the preview reflects the new action mode
    if (matchResults.some(r => r && r.matched)) renderRight();
});
elSource.addEventListener("change", persistPrefs);

/* ─── Last-used preferences (shared localStorage, all build targets) ──────
   localStorage is per-origin and persists across sessions identically in the
   Electron renderer and a Docker browser tab, so one implementation covers all
   targets with no file-permission or config-path differences. */
const PREFS_KEY = "cinesort.prefs.v1";
const VALID_THEMES = ["dark", "light", "aurora"];

function currentTheme() {
    return document.documentElement.getAttribute("data-theme") || "dark";
}
function applyTheme(name) {
    const t = VALID_THEMES.includes(name) ? name : "dark";
    document.documentElement.setAttribute("data-theme", t);
    // Reflect the choice in the Settings picker if it's open.
    document.querySelectorAll(".theme-swatch").forEach(b =>
        b.classList.toggle("active", b.dataset.theme === t));
    persistPrefs();
}

function persistPrefs() {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({
            datasource: elSource.value,
            action: elAction.value,
            template: elTemplate.value,
            scanPath: elScanPath.value,
            theme: currentTheme(),
        }));
    } catch { /* storage disabled — non-fatal */ }
}
function restorePrefs() {
    let p;
    try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); }
    catch { p = {}; }
    if (!p || typeof p !== "object") p = {};
    // Only apply values that are still valid options (guards against stale data).
    if (p.datasource && [...elSource.options].some(o => o.value === p.datasource)) elSource.value = p.datasource;
    if (p.action && [...elAction.options].some(o => o.value === p.action)) elAction.value = p.action;
    if (typeof p.template === "string" && p.template) elTemplate.value = p.template;
    if (typeof p.scanPath === "string" && p.scanPath) elScanPath.value = p.scanPath;
    applyTheme(p.theme || "dark");
}
restorePrefs();

updateActionHint(); // run once on load (after prefs restore so it reflects the saved action)


elScanPath.addEventListener("keydown", e => { if (e.key === "Enter") doScan(); });

/* ─── Browse ──────────────────────────────────────────────── */
// Desktop builds (deb/AppImage) use the native OS picker, which reaches $HOME
// and any mount/share. Docker and plain-browser builds fall back to the
// server-side HTML browser, which stays restricted to mounted volumes.
btnBrowse.addEventListener("click", () => {
    if (isElectron && typeof window.electronAPI.pickPaths === "function") {
        showNativePicker();
    } else {
        // No arg → showBrowseDialog resolves the default root from /api/browse-roots
        // (first existing mounted volume, e.g. /media). Avoids landing on a
        // non-existent /mnt in Docker, which looked like "nothing to select".
        showBrowseDialog();
    }
});

/* Shared: scan a list of file/folder paths and load them into the panes. */
async function scanPaths(paths) {
    status(`Scanning ${paths.length} item(s)…`);
    try {
        const data = await api("/api/scan-batch", {
            method: "POST",
            body: JSON.stringify({ paths }),
        });
        scannedFiles = data.files;
        matchResults = [];
        selectedSet = new Set(scannedFiles.map((_, i) => i));
        renderLeft();
        renderRight();
        renderGutter();
        btnMatch.disabled = scannedFiles.length === 0;
        btnRename.disabled = true;
        updateTemplatePreview();   // preview now has a real sample file
        statusDone(`Found ${scannedFiles.length} media file(s)`);
    } catch (err) {
        statusDone("Scan failed: " + err.message);
    }
}

/* Native picker chooser (Electron only). On Linux a single GTK dialog can be
   either a file or a folder selector, not both, so we offer the choice. */
function showNativePicker() {
    modalTitle.textContent = "Add Media";
    modalBody.innerHTML = `
        <p style="color:var(--txt2);font-size:12px;margin-bottom:16px;line-height:1.6">
            Pick folders or files anywhere on this computer — your home folder,
            mounted drives, or network shares. You can also drag &amp; drop them
            onto the window.
        </p>
        <div style="display:flex;gap:10px">
            <button class="glass-btn btn-scan" id="pick-folders" style="flex:1;padding:16px;font-size:13px">
                📁 Choose Folder(s)
            </button>
            <button class="glass-btn" id="pick-files" style="flex:1;padding:16px;font-size:13px">
                📄 Choose File(s)
            </button>
        </div>`;
    modalOverlay.classList.remove("hidden");
    $id("pick-folders").addEventListener("click", () => nativePick("folders"));
    $id("pick-files").addEventListener("click", () => nativePick("files"));
}

async function nativePick(mode) {
    const properties = mode === "folders"
        ? ["openDirectory", "multiSelections", "showHiddenFiles", "createDirectory"]
        : ["openFile", "multiSelections", "showHiddenFiles"];

    let paths = [];
    try {
        paths = await window.electronAPI.pickPaths({ properties });
    } catch (err) {
        modalOverlay.classList.add("hidden");
        statusDone("Picker failed: " + err.message);
        return;
    }

    modalOverlay.classList.add("hidden");
    if (!paths || paths.length === 0) return;   // cancelled
    await scanPaths(paths);
}

// Cached /api/browse-roots payload (shortcuts + default path + media exts).
let _browseRootsCache = null;
async function getBrowseRoots() {
    if (_browseRootsCache) return _browseRootsCache;
    try {
        _browseRootsCache = await api("/api/browse-roots");
    } catch {
        // Fallback to the historical defaults if the endpoint is unavailable.
        _browseRootsCache = {
            default_path: "/mnt",
            shortcuts: [{ name: "mnt", path: "/mnt" }, { name: "media", path: "/media" }],
            media_extensions: [],
        };
    }
    return _browseRootsCache;
}

async function showBrowseDialog(startPath) {
    modalTitle.textContent = "Browse Folders";

    const rootsInfo = await getBrowseRoots();
    const shortcuts = rootsInfo.shortcuts || [];
    const mediaExts = new Set(rootsInfo.media_extensions || []);
    if (!startPath) startPath = rootsInfo.default_path || "/mnt";

    // State persists across navigation (selection is no longer cleared on cd).
    const selectedPaths = new Set();
    let currentItems = [];
    let currentPath  = startPath;
    let mediaOnly    = false;
    let filterText   = "";
    let kbIndex      = -1;   // keyboard-focused index into the *visible* list

    function isMediaName(name) {
        const dot = name.lastIndexOf(".");
        if (dot < 0) return false;
        return mediaExts.has(name.slice(dot).toLowerCase());
    }

    function visibleItems() {
        const ft = filterText.trim().toLowerCase();
        return currentItems.filter(item => {
            if (item.type === "parent") return true;
            if (ft && !item.name.toLowerCase().includes(ft)) return false;
            if (mediaOnly && item.type === "file" && !isMediaName(item.name)) return false;
            return true;
        });
    }

    async function loadPath(path) {
        try {
            const data = await api(`/api/browse?path=${encodeURIComponent(path)}`);
            currentItems = data.items;
            currentPath  = data.path;
            filterText   = "";
            kbIndex      = -1;
            renderAll();
        } catch (err) {
            currentItems = [];
            currentPath  = path;
            renderAll(err.message);
        }
    }

    /* ── Full chrome (sidebar, path bar, crumbs, toolbar, list shell, actions) ── */
    function renderAll(error = null) {
        // Sidebar shortcuts
        let side = `<div class="browse-side"><div class="browse-side-title">Shortcuts</div>`;
        for (const sc of shortcuts) {
            const active = (currentPath === sc.path) ? " active" : "";
            side += `<button class="browse-shortcut${active}" data-path="${esc(sc.path)}" title="${esc(sc.path)}">📂 ${esc(sc.name || sc.path)}</button>`;
        }
        side += `</div>`;

        // Breadcrumb (clickable segments)
        const parts = currentPath.split("/").filter(Boolean);
        let crumbs = `<button class="crumb" data-path="/">/</button>`;
        let acc = "";
        for (const part of parts) {
            acc += "/" + part;
            crumbs += `<span class="crumb-sep">›</span><button class="crumb" data-path="${esc(acc)}">${esc(part)}</button>`;
        }

        let main = `<div class="browse-main">`;
        main += `<div class="browse-pathrow">
            <input type="text" id="browse-path-input" class="glass-input mono" spellcheck="false"
                   value="${esc(currentPath)}" placeholder="/path/to/folder">
            <button class="glass-btn" id="browse-go">Go</button>
        </div>`;
        main += `<div class="browse-crumbs">${crumbs}</div>`;
        main += `<div class="browse-toolbar">
            <input type="text" id="browse-filter" class="glass-input" spellcheck="false"
                   placeholder="Filter this folder…" value="${esc(filterText)}">
            <label class="cb-label"><input type="checkbox" id="browse-mediaonly" ${mediaOnly ? "checked" : ""}><span>Media only</span></label>
        </div>`;
        if (error) {
            main += `<p class="browse-error">${esc(error)}</p>`;
        }
        main += `<div id="browser-list" tabindex="0" class="browse-list" role="listbox" aria-multiselectable="true" aria-label="Folder contents"></div>`;
        main += `<div class="browse-tray" id="browse-tray"></div>`;
        main += `<div class="browse-actions">
            <button class="glass-btn" id="browse-select-visible">Select Visible</button>
            <button class="glass-btn" id="browse-cancel">Cancel</button>
            <button class="glass-btn btn-scan" id="browse-scan">Scan</button>
        </div>`;
        main += `</div>`;

        modalBody.innerHTML = `<div class="browse-wrap">${side}${main}</div>`;

        // Wire chrome-level handlers (these elements survive across list re-renders)
        modalBody.querySelectorAll(".browse-shortcut").forEach(b =>
            b.addEventListener("click", () => loadPath(b.dataset.path)));
        modalBody.querySelectorAll(".crumb").forEach(b =>
            b.addEventListener("click", () => loadPath(b.dataset.path)));

        const pathInput = $id("browse-path-input");
        const go = () => { const v = pathInput.value.trim(); if (v) loadPath(v); };
        $id("browse-go").addEventListener("click", go);
        pathInput.addEventListener("keydown", e => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); go(); }
        });

        const filterInput = $id("browse-filter");
        filterInput.addEventListener("input", () => { filterText = filterInput.value; kbIndex = -1; renderList(); });
        filterInput.addEventListener("keydown", e => e.stopPropagation());

        $id("browse-mediaonly").addEventListener("change", e => { mediaOnly = e.target.checked; kbIndex = -1; renderList(); });

        $id("browse-select-visible").addEventListener("click", () => {
            for (const item of visibleItems()) {
                if (item.type !== "parent") selectedPaths.add(item.path);
            }
            renderList();
        });
        $id("browse-cancel").addEventListener("click", () => modalOverlay.classList.add("hidden"));
        $id("browse-scan").addEventListener("click", doScanSelection);

        // Keyboard navigation — attached once per chrome render (the list element
        // persists across cheap renderList() calls, so wiring it there would
        // stack duplicate handlers).
        $id("browser-list").addEventListener("keydown", e => {
            // Stop browser-list keys from reaching the document-level shortcuts
            // (Delete/Ctrl+A/F2) so they can't act on the panes behind the modal.
            // Escape is intentionally left to bubble so it still closes the modal.
            if (e.key !== "Escape") e.stopPropagation();
            const vis = visibleItems();
            if (e.key === "ArrowDown") { e.preventDefault(); kbIndex = Math.min(kbIndex + 1, vis.length - 1); renderList(); }
            else if (e.key === "ArrowUp") { e.preventDefault(); kbIndex = Math.max(kbIndex - 1, 0); renderList(); }
            else if (e.key === "Backspace") {
                e.preventDefault();
                const parent = vis.find(it => it.type === "parent");
                if (parent) loadPath(parent.path);
            }
            else if ((e.ctrlKey || e.metaKey) && e.key === "a") {
                e.preventDefault();
                for (const it of vis) if (it.type !== "parent") selectedPaths.add(it.path);
                renderList();
            }
            else if (kbIndex >= 0 && kbIndex < vis.length) {
                const it = vis[kbIndex];
                if (e.key === "Enter") {
                    e.preventDefault();
                    if (it.type === "directory" || it.type === "parent") loadPath(it.path);
                    else doScanSelection();
                } else if (e.key === " ") {
                    e.preventDefault();
                    if (it.type !== "parent") {
                        if (selectedPaths.has(it.path)) selectedPaths.delete(it.path); else selectedPaths.add(it.path);
                        renderList();
                    }
                }
            }
        });

        renderList();
    }

    /* ── Just the list + selection tray (cheap re-render on filter/select) ── */
    function renderList() {
        const items = visibleItems();
        const listEl = $id("browser-list");
        if (!listEl) return;

        if (items.length === 0) {
            listEl.innerHTML = `<div class="browse-empty">Nothing to show here</div>`;
        } else {
            let html = "";
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const isParent = item.type === "parent";
                const isDir = item.type === "directory" || isParent;
                const icon = isParent ? "↩️" : isDir ? "📁" : "📄";
                const size = item.size != null ? fmt(item.size) : "";
                const checked = selectedPaths.has(item.path) ? "checked" : "";
                const kb = (i === kbIndex) ? " kb-focus" : "";
                const checkbox = isParent ? "" : `<input type="checkbox" ${checked} data-idx="${i}" aria-label="Select ${esc(item.name)}">`;
                const ariaSel = isParent ? "" : ` role="option" aria-selected="${selectedPaths.has(item.path)}"`;
                html += `<div class="browser-item${isDir ? " browser-dir" : ""}${kb}"${ariaSel} data-path="${esc(item.path)}" data-idx="${i}" data-is-dir="${isDir}" data-is-parent="${isParent}">
                    ${checkbox}
                    <span class="bi-icon">${icon}</span>
                    <span class="bi-name">${esc(item.name)}</span>
                    ${size ? `<span class="bi-size">${size}</span>` : ""}
                </div>`;
            }
            listEl.innerHTML = html;
        }

        // Checkbox toggles
        listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener("change", e => {
                e.stopPropagation();
                const item = items[parseInt(cb.dataset.idx)];
                if (cb.checked) selectedPaths.add(item.path); else selectedPaths.delete(item.path);
                updateTray();
            });
        });

        // Row click (toggle dir checkbox) / double-click (navigate)
        listEl.querySelectorAll(".browser-item").forEach(el => {
            el.addEventListener("click", e => {
                if (e.target.tagName === "INPUT") return;
                if (el.dataset.isParent === "true") { loadPath(el.dataset.path); return; }
                const cb = el.querySelector('input[type="checkbox"]');
                if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); }
            });
            el.addEventListener("dblclick", e => {
                if (e.target.matches('input[type="checkbox"]')) return;
                if (el.dataset.isDir === "true") loadPath(el.dataset.path);
            });
        });

        setTimeout(() => {
            listEl.focus();
            listEl.querySelector(".kb-focus")?.scrollIntoView({ block: "nearest" });
        }, 0);

        updateTray();
    }

    function updateTray() {
        const tray = $id("browse-tray");
        const scanBtn = $id("browse-scan");
        const n = selectedPaths.size;
        if (tray) {
            tray.innerHTML = n > 0
                ? `<span>${n} selected (across folders)</span> <button class="linklike" id="browse-clearsel">clear</button>`
                : `<span class="browse-tray-empty">Nothing selected — Scan will use the current folder</span>`;
            const clr = $id("browse-clearsel");
            if (clr) clr.addEventListener("click", () => { selectedPaths.clear(); renderList(); });
        }
        if (scanBtn) scanBtn.textContent = n > 0 ? `Scan ${n} Selected` : "Scan Current Folder";
    }

    async function doScanSelection() {
        modalOverlay.classList.add("hidden");
        if (selectedPaths.size > 0) {
            await scanPaths(Array.from(selectedPaths));
        } else {
            elScanPath.value = currentPath;
            doScan();
        }
    }

    modalOverlay.classList.remove("hidden");
    modalBody.innerHTML = `<div style="text-align:center;padding:40px;color:var(--txt3)">Loading...</div>`;
    await loadPath(startPath);
}

async function doScan() {
    const path = elScanPath.value.trim();
    if (!path) { elScanPath.focus(); return; }

    status("Scanning…");
    btnScan.disabled = true;

    try {
        const data = await api("/api/scan", {
            method: "POST",
            body: JSON.stringify({ path, recursive: elRecursive.checked }),
        });
        scannedFiles = data.files;
        matchResults = [];
        selectedSet = new Set(scannedFiles.map((_, i) => i));
        renderLeft();
        renderRight();
        renderGutter();
        btnMatch.disabled = scannedFiles.length === 0;
        btnRename.disabled = true;
        persistPrefs();            // remember this folder for next session
        updateTemplatePreview();   // preview now has a real sample file
        statusDone(`Found ${scannedFiles.length} media file(s)`);
    } catch (err) {
        statusDone("Scan failed: " + err.message);
    } finally {
        btnScan.disabled = false;
    }
}

/* ─── Match ───────────────────────────────────────────────── */
btnMatch.addEventListener("click", doMatch);

async function doMatch() {
    if (scannedFiles.length === 0) return;

    const filesToMatch = scannedFiles.filter((_, i) => selectedSet.has(i));
    if (filesToMatch.length === 0) return;

    // /api/match is a single request (kept that way to preserve cross-file
    // grouping + subtitle pairing + conflict detection — see IMPROVEMENTS §4.5).
    // Since we can't show determinate per-file progress without server-side
    // streaming, surface an elapsed-time ticker so a long lookup never looks
    // frozen behind the indeterminate bar.
    const src = elSource.value.toUpperCase();
    const t0 = Date.now();
    status(`Matching ${filesToMatch.length} file(s) against ${src}…`);
    const ticker = setInterval(() => {
        // Update only the text so the indeterminate bar's animation isn't reset.
        const secs = Math.round((Date.now() - t0) / 1000);
        statusText.textContent = `Matching ${filesToMatch.length} file(s) against ${src}… ${secs}s`;
    }, 1000);
    btnMatch.disabled = true;

    try {
        const data = await api("/api/match", {
            method: "POST",
            body: JSON.stringify({
                files: filesToMatch,
                datasource: elSource.value,
                template: elTemplate.value,
                include_adult: elIncludeAdult.checked,
            }),
        });
        clearInterval(ticker);

        // Check if we need user to select from multiple shows
        if (data.needs_selection) {
            statusHide();
            showSelectionDialog(data.group_name, data.candidates, filesToMatch);
            return;
        }

        // Rebuild matchResults aligned to scannedFiles
        matchResults = new Array(scannedFiles.length).fill(null);
        const resultMap = new Map();
        for (const r of data.results) {
            resultMap.set(r.original, r);
        }
        for (let i = 0; i < scannedFiles.length; i++) {
            matchResults[i] = resultMap.get(scannedFiles[i].path) || null;
        }

        applyConfidenceGate();
        renderLeft();   // reflect any rows the gate deselected
        renderRight();
        renderGutter();
        btnRename.disabled = !matchResults.some(r => r && r.matched);
        const matched = matchResults.filter(r => r && r.matched).length;

        // Show conflicts if any
        if (data.conflicts && data.conflicts.length > 0) {
            showConflictsDialog(data.conflicts);
            statusDone(`Matched ${matched} of ${filesToMatch.length} file(s) — ${data.conflicts.length} conflict(s) found`);
        } else {
            statusDone(`Matched ${matched} of ${filesToMatch.length} file(s)`);
        }
    } catch (err) {
        statusDone("Match failed: " + err.message);
    } finally {
        clearInterval(ticker);
        btnMatch.disabled = scannedFiles.length === 0;
    }
}

/* ─── Rename ──────────────────────────────────────────────── */
btnRename.addEventListener("click", doRename);

async function doRename() {
    const ops = [];
    for (let i = 0; i < scannedFiles.length; i++) {
        if (!selectedSet.has(i)) continue;
        const m = matchResults[i];
        if (!m || !m.matched) continue;
        ops.push({ original: m.original, new_path: m.new_path });
    }
    if (ops.length === 0) return;

    const action = elAction.value;
    status(`Renaming ${ops.length} file(s) (${action})…`);
    btnRename.disabled = true;

    try {
        const data = await api("/api/rename", {
            method: "POST",
            body: JSON.stringify({ operations: ops, action }),
        });
        showRenameResults(data);
        statusDone(`${data.success} succeeded, ${data.failed} failed`);
        
        // Clear everything after successful rename
        if (data.success > 0) {
            scannedFiles = [];
            matchResults = [];
            selectedSet = new Set();
            renderLeft();
            renderRight();
            renderGutter();
            btnMatch.disabled = true;
            btnRename.disabled = true;
        }
    } catch (err) {
        statusDone("Rename failed: " + err.message);
    } finally {
        btnRename.disabled = false;
    }
}

function showRenameResults(data) {
    modalTitle.textContent = `Rename Results — ${data.action}`;
    let html = `<p style="margin-bottom:10px;color:var(--txt2)">
        ${data.success} succeeded, ${data.failed} failed of ${data.total}</p>`;
    for (const r of data.results) {
        if (r.success) {
            html += `<div class="res-row">
                <span class="res-icon ok">✓</span>
                <span class="res-text">${esc(r.destination)}</span>
            </div>`;
        } else {
            html += `<div class="res-row">
                <span class="res-icon fail">✗</span>
                <span class="res-text">${esc(r.original)}</span>
            </div>
            <div class="res-err">${esc(r.error)}</div>`;
        }
    }
    modalBody.innerHTML = html;
    modalOverlay.classList.remove("hidden");
}

/* ─── Settings ────────────────────────────────────────────── */
const btnSettings = $id("btn-settings");
btnSettings.addEventListener("click", showSettings);

async function showSettings() {
    modalTitle.textContent = "Settings";
    modalBody.innerHTML = `<div style="text-align:center;padding:20px;color:var(--txt3)">Loading…</div>`;
    modalOverlay.classList.remove("hidden");

    let current;
    try {
        current = await api("/api/settings");
    } catch {
        modalBody.innerHTML = `<p style="color:var(--red);font-size:12px">Failed to load settings.</p>`;
        return;
    }

    const tmdbSet  = current.tmdb_key_set;
    const omdbSet  = current.omdb_key_set;
    const cfgFile  = current.config_file || "";

    const badge = set => set
        ? `<span class="settings-badge ok">● Active</span>`
        : `<span class="settings-badge missing">○ Not set</span>`;

    const th = currentTheme();
    const swatch = (id, label) =>
        `<div class="theme-swatch ${th === id ? "active" : ""}" data-theme="${id}">
            <span class="theme-dot dot-${id}"></span>${label}
        </div>`;

    modalBody.innerHTML = `
        <div class="settings-row">
            <div class="settings-label"><span>Appearance</span></div>
            <p class="settings-hint">Theme is remembered on this device.</p>
            <div class="theme-picker" id="theme-picker">
                ${swatch("dark", "Dark")}
                ${swatch("light", "Light")}
                ${swatch("aurora", "Aurora")}
            </div>
        </div>

        <p style="color:var(--txt3);font-size:11px;margin:16px 0;line-height:1.6">
            Keys are saved to <code class="settings-path">${esc(cfgFile)}</code> and take
            effect immediately — no restart needed.
            Docker users: set them as environment variables in
            <code>docker-compose.yml</code> instead.
        </p>

        <div class="settings-row">
            <div class="settings-label">
                <span>TMDb API key</span>${badge(tmdbSet)}
            </div>
            <p class="settings-hint">
                Required for TV + movie metadata.
                Get a free key at
                <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer">themoviedb.org</a>.
            </p>
            <div class="settings-input-row">
                <input type="password" id="set-tmdb" class="glass-input mono"
                       placeholder="${tmdbSet ? "••••••••  (leave blank to keep current)" : "Paste key here…"}"
                       autocomplete="off" spellcheck="false">
                <button class="settings-eye" data-target="set-tmdb" title="Show/hide">👁</button>
            </div>
        </div>

        <div class="settings-row">
            <div class="settings-label">
                <span>OMDb API key</span>${badge(omdbSet)}
            </div>
            <p class="settings-hint">
                Enables IMDb data + adult-title fallback search. Free: 1,000 req/day.
                Get a free key at
                <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener noreferrer">omdbapi.com</a>.
            </p>
            <div class="settings-input-row">
                <input type="password" id="set-omdb" class="glass-input mono"
                       placeholder="${omdbSet ? "••••••••  (leave blank to keep current)" : "Paste key here…"}"
                       autocomplete="off" spellcheck="false">
                <button class="settings-eye" data-target="set-omdb" title="Show/hide">👁</button>
            </div>
        </div>

        <div style="display:flex;gap:8px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
            <button class="glass-btn" onclick="R.closeModal()" style="flex:1">Cancel</button>
            <button class="glass-btn btn-scan" id="settings-save" style="flex:2">Save &amp; Apply</button>
        </div>
        <p id="settings-msg" style="font-size:11px;margin-top:10px;min-height:16px"></p>`;

    // Theme picker — applies instantly and persists.
    modalBody.querySelectorAll(".theme-swatch").forEach(sw => {
        sw.addEventListener("click", () => applyTheme(sw.dataset.theme));
    });

    // Show/hide toggles
    modalBody.querySelectorAll(".settings-eye").forEach(btn => {
        btn.addEventListener("click", () => {
            const inp = $id(btn.dataset.target);
            inp.type = inp.type === "password" ? "text" : "password";
        });
    });

    $id("settings-save").addEventListener("click", async () => {
        const tmdbVal = $id("set-tmdb").value.trim();
        const omdbVal = $id("set-omdb").value.trim();
        const msg     = $id("settings-msg");

        // Basic client-side length check (mirrors server-side validation)
        for (const [label, val] of [["TMDb key", tmdbVal], ["OMDb key", omdbVal]]) {
            if (val && (val.length < 8 || val.length > 256 || /\s/.test(val))) {
                msg.style.color = "var(--red)";
                msg.textContent = `${label}: must be 8–256 characters with no spaces.`;
                return;
            }
        }

        const saveBtn = $id("settings-save");
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
        msg.textContent = "";

        try {
            const result = await api("/api/settings", {
                method: "POST",
                body: JSON.stringify({ tmdb_key: tmdbVal, omdb_key: omdbVal }),
            });
            msg.style.color = "var(--green)";
            msg.textContent = "✓ Saved. Keys are active for this session.";
            saveBtn.textContent = "Saved!";
            // Hide the first-run banner once keys are saved
            if (result.tmdb_enabled) keyBanner.classList.add("hidden");
            // Refresh badge status
            setTimeout(() => showSettings(), 1200);
        } catch (err) {
            msg.style.color = "var(--red)";
            msg.textContent = "Error: " + err.message;
            saveBtn.disabled = false;
            saveBtn.textContent = "Save & Apply";
        }
    });
}

/* ─── History ─────────────────────────────────────────────── */
btnHistory.addEventListener("click", showHistory);

async function showHistory() {
    modalTitle.textContent = "Rename History";
    modalBody.innerHTML = `<div style="text-align:center;padding:20px;color:var(--txt3)">Loading...</div>`;
    modalOverlay.classList.remove("hidden");
    
    try {
        const data = await api("/api/history");
        const entries = data.history || [];
        
        if (entries.length === 0) {
            modalBody.innerHTML = `<div style="text-align:center;padding:20px;color:var(--txt3)">No history yet</div>`;
            return;
        }
        
        let html = `<div style="max-height:400px;overflow-y:auto;display:flex;flex-direction:column;gap:8px">`;
        
        for (const e of entries) {
            const time = new Date(e.timestamp).toLocaleString();
            const actionColor = e.action === "move" ? "#6ee7b7" : e.action === "copy" ? "#93c5fd" : "#fde047";
            const statusIcon = e.success ? "✓" : "✗";
            const statusColor = e.success ? "#6ee7b7" : "#f87171";
            
            html += `<div style="padding:10px;background:var(--glass-hover);border:1px solid var(--border);border-radius:6px">`;
            html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">`;
            html += `<div style="display:flex;gap:8px;align-items:center">`;
            html += `<span style="color:${statusColor};font-weight:600">${statusIcon}</span>`;
            html += `<span style="color:${actionColor};font-weight:500;font-size:11px;text-transform:uppercase">${e.action}</span>`;
            html += `<span style="color:var(--txt3);font-size:10px">${time}</span>`;
            html += `</div>`;
            if (e.success && e.action !== "test" && e.action !== "undo") {
                html += `<button class="glass-btn" onclick="R.undoOperation('${e.id}')" style="padding:3px 10px;font-size:10px">Undo</button>`;
            }
            html += `</div>`;
            html += `<div style="font-size:10px;color:var(--txt3);line-height:1.6">`;
            html += `<div>From: ${esc(Path.basename(e.original))}</div>`;
            html += `<div>To: ${esc(Path.basename(e.destination))}</div>`;
            if (e.error) html += `<div style="color:#f87171">Error: ${esc(e.error)}</div>`;
            html += `</div>`;
            html += `</div>`;
        }
        
        html += `</div>`;
        html += `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:flex;gap:8px">`;
        html += `<button class="glass-btn" onclick="R.clearHistory()" style="flex:1;font-size:11px">Clear History</button>`;
        html += `<button class="glass-btn" onclick="R.closeModal()" style="flex:1;font-size:11px">Close</button>`;
        html += `</div>`;
        
        modalBody.innerHTML = html;
    } catch (err) {
        modalBody.innerHTML = `<div style="text-align:center;padding:20px;color:#f87171">Failed to load history: ${esc(err.message)}</div>`;
    }
}

/* ─── Render Left Pane (Original Files) ───────────────────── */
function renderLeft() {
    leftCount.textContent = scannedFiles.length;

    if (scannedFiles.length === 0) {
        // Build-aware hint: the desktop app has a native picker reaching $HOME,
        // while Docker users browse their mounted volumes.
        const hint = isElectron
            ? "or click Browse to choose a folder or files"
            : "or enter a folder path above, or click Browse, then Scan";
        leftList.innerHTML = `
            <div class="drop-zone active" id="drop-zone">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.25">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/>
                    <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <p>Drop media files here</p>
                <p class="drop-hint">${hint}</p>
            </div>`;
        return;
    }

    let html = "";
    for (let i = 0; i < scannedFiles.length; i++) {
        const f = scannedFiles[i];
        const checked = selectedSet.has(i) ? "checked" : "";
        const typeTag = f.media_type === "series"
            ? '<span class="tag series">TV</span>'
            : f.media_type === "movie"
            ? '<span class="tag movie">Film</span>'
            : '<span class="tag">?</span>';
        const sxeTag = f.season != null
            ? `<span class="tag sxe">S${String(f.season).padStart(2,"0")}E${String(f.episode).padStart(2,"0")}</span>`
            : "";
        const sizeTag = f.size ? `<span class="tag">${fmt(f.size)}</span>` : "";
        const vfTag = f.video_format ? `<span class="tag">${f.video_format}</span>` : "";

        html += `<div class="row-item" data-idx="${i}" draggable="true"
                      role="option" tabindex="-1" aria-selected="${selectedSet.has(i)}"
                      aria-label="${esc(f.filename)}"
                      onmouseenter="R.hoverRow(${i})" onmouseleave="R.unhoverRow(${i})"
                      oncontextmenu="R.showContextMenu(event, ${i}, 'left')"
                      ondragstart="R.dragStart(event, ${i}, 'left')"
                      ondragover="R.dragOver(event, ${i}, 'left')"
                      ondrop="R.drop(event, ${i}, 'left')"
                      ondragend="R.dragEnd(event)">
            <div class="row-cb"><input type="checkbox" ${checked} data-idx="${i}" aria-label="Select ${esc(f.filename)}"></div>
            <div class="row-icon">${fileIcon(f.media_type)}</div>
            <span class="row-text original" title="${esc(f.path)}">${esc(f.filename)}</span>
            <div class="row-tags">${typeTag}${sxeTag}${vfTag}${sizeTag}</div>
        </div>`;
    }
    leftList.innerHTML = html;

    // Checkbox listeners
    leftList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener("change", e => {
            const idx = parseInt(e.target.dataset.idx);
            if (e.target.checked) selectedSet.add(idx);
            else selectedSet.delete(idx);
        });
    });

    // Row click → set keyboard focus (ignore checkbox clicks)
    leftList.querySelectorAll(".row-item[data-idx]").forEach(el => {
        el.addEventListener("click", e => {
            if (e.target.tagName === "INPUT") return;
            focusRow(parseInt(el.dataset.idx));
        });
    });

    // Restore focused row highlight after re-render
    if (focusedIdx !== null && focusedIdx < scannedFiles.length) {
        leftList.querySelector(`.row-item[data-idx="${focusedIdx}"]`)?.classList.add("row-focused");
    }
}

/* ─── Render Right Pane (New Names) ───────────────────────── */
const PENCIL_SVG = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

function renderRight() {
    const matched = matchResults.filter(r => r && r.matched).length;
    rightCount.textContent = matched;

    if (matchResults.every(r => r === null)) {
        rightList.innerHTML = `<div class="empty-right"><p>Click <strong>Match</strong> to look up metadata</p><p class="drop-hint" style="margin-top:6px">Right-click or press F2 to name files manually</p></div>`;
        return;
    }

    let html = "";
    for (let i = 0; i < scannedFiles.length; i++) {
        const m = matchResults[i];

        /* ── Not yet attempted (scan done, match not run) ── */
        if (!m) {
            html += `<div class="row-item" data-idx="${i}"
                          onmouseenter="R.hoverRow(${i})" onmouseleave="R.unhoverRow(${i})"
                          oncontextmenu="R.showContextMenu(event, ${i}, 'right')"
                          ondblclick="R.startInlineEdit(${i})">
                <span class="row-text unmatched">—</span>
                <button class="row-edit-btn" title="Set name manually (double-click or F2)"
                        onclick="event.stopPropagation();R.startInlineEdit(${i})">${PENCIL_SVG}</button>
            </div>`;
            continue;
        }

        /* ── Auto-matched or manually named ── */
        if (m.matched) {
            const isManual = !!m.manual;
            const poster = (!isManual && m.metadata?.poster)
                ? `<img src="${esc(m.metadata.poster)}" alt="">`
                : fileIcon(isManual ? "edit" : "matched");

            let metaLine = "";
            if (!isManual && m.metadata?.show) {
                const title = m.metadata.title || "";
                const year = scannedFiles[i]?.year || "";
                metaLine = `<div class="meta-detail" title="${esc(title)}">`;
                metaLine += `<span class="meta-show">${esc(m.metadata.show)}</span>`;
                if (year) metaLine += ` <span class="meta-year">(${year})</span>`;
                metaLine += ` • <span class="meta-ep">S${String(m.metadata.season||0).padStart(2,"0")}E${String(m.metadata.episode||0).padStart(2,"0")}</span>`;
                if (title) metaLine += ` • <span class="meta-title">${esc(title)}</span>`;
                metaLine += `</div>`;
            } else if (!isManual && m.metadata?.title) {
                const year = m.metadata.year || "";
                metaLine = `<div class="meta-detail"><span class="meta-show">${esc(m.metadata.title)}</span>`;
                if (year) metaLine += ` <span class="meta-year">(${year})</span>`;
                metaLine += `</div>`;
            }

            // For rename (in-place) show only the filename, not the full template path
            const displayName = elAction.value === "rename"
                ? (m.new_name || "")
                : (m.preview || m.new_name || "");

            // Three-tier confidence: high ≥0.6, review ≥0.4, low <0.4.
            // Low-confidence matches are flagged "review" and were deselected
            // by the confidence gate so they aren't renamed unless re-checked.
            const scoreCls = m.score >= 0.6 ? "score-hi" : m.score >= LOW_CONFIDENCE ? "score-mid" : "score-lo";
            const reviewTag = (!isManual && m.score < LOW_CONFIDENCE)
                ? `<span class="tag score-review" title="Low confidence — review before renaming (not auto-selected)">review</span>`
                : "";
            const scoreTag = isManual
                ? `<span class="tag manual">manual</span>`
                : `${reviewTag}<span class="tag ${scoreCls}">${Math.round(m.score * 100)}%</span>`;

            html += `<div class="row-item" data-idx="${i}" draggable="true"
                          onmouseenter="R.hoverRow(${i})" onmouseleave="R.unhoverRow(${i})"
                          oncontextmenu="R.showContextMenu(event, ${i}, 'right')"
                          ondragstart="R.dragStart(event, ${i}, 'right')"
                          ondragover="R.dragOver(event, ${i}, 'right')"
                          ondrop="R.drop(event, ${i}, 'right')"
                          ondragend="R.dragEnd(event)"
                          ondblclick="R.startInlineEdit(${i})">
                <div class="row-icon">${poster}</div>
                <div style="flex:1;min-width:0;">
                    <span class="row-text newname" title="${esc(displayName)}">${esc(displayName)}</span>
                    ${metaLine}
                </div>
                <div class="row-tags">
                    ${scoreTag}
                    <button class="row-edit-btn" title="Edit name (double-click or F2)"
                            onclick="event.stopPropagation();R.startInlineEdit(${i})">${PENCIL_SVG}</button>
                </div>
            </div>`;
            continue;
        }

        /* ── Match attempted, failed → prominent edit CTA ── */
        html += `<div class="row-item row-unmatched-cta" data-idx="${i}"
                      onmouseenter="R.hoverRow(${i})" onmouseleave="R.unhoverRow(${i})"
                      oncontextmenu="R.showContextMenu(event, ${i}, 'right')"
                      ondblclick="R.startInlineEdit(${i})">
            <div class="row-icon">${fileIcon("edit")}</div>
            <span class="row-text unmatched">No match found</span>
            <button class="row-edit-btn row-edit-btn-cta" title="Name this file manually"
                    onclick="event.stopPropagation();R.startInlineEdit(${i})">${PENCIL_SVG} Edit</button>
        </div>`;
    }
    rightList.innerHTML = html;

    // Row click → set keyboard focus
    rightList.querySelectorAll(".row-item[data-idx]").forEach(el => {
        el.addEventListener("click", e => {
            if (e.target.closest(".row-edit-btn")) return;
            focusRow(parseInt(el.dataset.idx));
        });
    });

    // Restore focused row highlight after re-render
    if (focusedIdx !== null && focusedIdx < scannedFiles.length) {
        rightList.querySelector(`.row-item[data-idx="${focusedIdx}"]`)?.classList.add("row-focused");
    }
}

/* ─── Render Gutter Arrows ────────────────────────────────── */
function renderGutter() {
    if (scannedFiles.length === 0) {
        gutter.innerHTML = "";
        return;
    }

    let html = "";
    for (let i = 0; i < scannedFiles.length; i++) {
        const m = matchResults[i];
        const cls = m && m.matched ? "matched" : "unmatched";
        html += `<div class="gutter-row ${cls}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
        </div>`;
    }
    gutter.innerHTML = html;
}

/* ─── Context menu ─────────────────────────────────────────── */
let contextMenu = null;

function createContextMenu() {
    const menu = document.createElement("div");
    menu.className = "context-menu glass-panel";
    menu.style.display = "none";
    document.body.appendChild(menu);
    return menu;
}

function showContextMenu(e, idx, pane) {
    e.preventDefault();
    focusRow(idx); // focus the right-clicked row so DEL works for the next one
    if (!contextMenu) contextMenu = createContextMenu();
    
    const f = scannedFiles[idx];
    const m = matchResults[idx];
    
    let html = `<div class="ctx-item ctx-delete" onclick="R.removeFile(${idx})"><span>🗑 Remove from list</span><kbd>Del</kbd></div>`;
    html += `<div class="ctx-sep"></div>`;
    if (pane === "left" && f) {
        html += `<div class="ctx-item" onclick="R.copyPath('${esc(f.path)}', event)">📋 Copy path</div>`;
        // "Show in folder" works only on desktop (Electron exposes shell). In
        // Docker/browser there is no OS file manager to reveal into, so it stays
        // disabled rather than silently doing nothing.
        if (canShowInFolder) {
            html += `<div class="ctx-item" onclick="R.showInFolder(${idx})">📁 Show in folder</div>`;
        } else {
            html += `<div class="ctx-item ctx-disabled" title="Available in the desktop app">📁 Show in folder</div>`;
        }
    }
    if (pane === "right") {
        html += `<div class="ctx-item" onclick="R.startInlineEdit(${idx});R.hideMenu()"><span>✏ Edit name manually</span><kbd>F2</kbd></div>`;
        if (m && m.matched && !m.manual) {
            html += `<div class="ctx-item" onclick="R.showMetadata(${idx})">ℹ️ View metadata</div>`;
        }
        if (m && m.matched && m.manual) {
            html += `<div class="ctx-item" onclick="R.clearManual(${idx})">↺ Clear manual name</div>`;
        }
    }
    
    contextMenu.innerHTML = html;
    contextMenu.style.display = "block";
    contextMenu.style.left = e.pageX + "px";
    contextMenu.style.top = e.pageY + "px";
    
    setTimeout(() => {
        document.addEventListener("click", hideContextMenu, { once: true });
    }, 10);
}

function hideContextMenu() {
    if (contextMenu) contextMenu.style.display = "none";
}

/* ─── Sync hover between panes ────────────────────────────── */
window.R = {
    // Inline onclick handlers run in GLOBAL scope, where the IIFE-local
    // `modalOverlay` / `hideContextMenu` are not visible. Routing them through
    // the global `R` object is what makes Cancel/Close/Done buttons work.
    closeModal() { modalOverlay.classList.add("hidden"); },
    hideMenu() { hideContextMenu(); },
    hoverRow(idx) {
        leftList.querySelector(`.row-item[data-idx="${idx}"]`)?.classList.add("peer-hover");
        rightList.querySelector(`.row-item[data-idx="${idx}"]`)?.classList.add("peer-hover");
    },
    unhoverRow(idx) {
        leftList.querySelector(`.row-item[data-idx="${idx}"]`)?.classList.remove("peer-hover");
        rightList.querySelector(`.row-item[data-idx="${idx}"]`)?.classList.remove("peer-hover");
    },
    showContextMenu,
    removeFile(idx) {
        removeSingleFile(idx);
    },
    focusRow,
    showInFolder(idx) {
        hideContextMenu();
        const f = scannedFiles[idx];
        if (!f || !canShowInFolder) return;
        window.electronAPI.showInFolder(f.path);
    },

    /* Inline conflict resolution (item 7) */
    conflictSkip(ci, j) {
        const c = _activeConflicts[ci];
        if (!c) return;
        const orig = c._origs[j];
        const idx = _findIdxByOriginal(orig);
        if (idx >= 0) selectedSet.delete(idx);   // exclude from the rename batch
        _activeConflicts.splice(ci, 1);
        renderLeft();
        renderRight();
        renderConflictsDialog();
        status(`Skipped ${Path.basename(orig)}`);
        setTimeout(() => statusHide(), 1500);
    },
    conflictBump(ci, j) {
        const c = _activeConflicts[ci];
        if (!c) return;
        const orig = c._origs[j];
        const idx = _findIdxByOriginal(orig);
        const m = matchResults[idx];
        if (m && m.new_path) {
            const oldName = m.new_name || Path.basename(m.new_path);
            const newName = _bumpFilename(oldName);
            const dir = m.new_path.slice(0, m.new_path.length - oldName.length);
            m.new_path = dir + newName;
            m.new_name = newName;
            if (typeof m.preview === "string" && m.preview.endsWith(oldName)) {
                m.preview = m.preview.slice(0, m.preview.length - oldName.length) + newName;
            } else {
                m.preview = newName;
            }
        }
        _activeConflicts.splice(ci, 1);
        renderRight();
        renderConflictsDialog();
        status(`Renamed to ${m && m.new_name ? m.new_name : "…(2)"}`);
        setTimeout(() => statusHide(), 1500);
    },
    copyPath(path, e) {
        e?.stopPropagation();
        navigator.clipboard.writeText(path).then(() => {
            status("Copied to clipboard");
            setTimeout(() => statusHide(), 1500);
        });
    },
    clearManual(idx) {
        if (!matchResults[idx]?.manual) return;
        matchResults[idx] = null;
        renderRight();
        renderGutter();
        btnRename.disabled = !matchResults.some(r => r && r.matched);
    },
    showMetadata(idx) {
        const m = matchResults[idx];
        if (!m || !m.matched) return;
        
        modalTitle.textContent = "Metadata";
        let html = `<div style="line-height:1.8;color:var(--txt2);font-size:12px">`;
        
        if (m.metadata?.show) {
            html += `<div><strong>Show:</strong> ${esc(m.metadata.show)}</div>`;
            html += `<div><strong>Season:</strong> ${m.metadata.season} <strong>Episode:</strong> ${m.metadata.episode}</div>`;
            if (m.metadata.title) html += `<div><strong>Title:</strong> ${esc(m.metadata.title)}</div>`;
        } else if (m.metadata?.title) {
            html += `<div><strong>Title:</strong> ${esc(m.metadata.title)}</div>`;
            if (m.metadata.year) html += `<div><strong>Year:</strong> ${m.metadata.year}</div>`;
        }
        
        const f = scannedFiles[idx];
        if (f) {
            html += `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">`;
            html += `<div><strong>Original:</strong> <code style="font-size:10px;color:var(--txt3)">${esc(f.filename)}</code></div>`;
            if (f.size) html += `<div><strong>Size:</strong> ${fmt(f.size)}</div>`;
            if (f.video_format) html += `<div><strong>Quality:</strong> ${f.video_format}</div>`;
            if (f.source) html += `<div><strong>Source:</strong> ${f.source}</div>`;
            if (f.group) html += `<div><strong>Group:</strong> ${f.group}</div>`;
            html += `</div>`;
        }
        
        html += `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">`;
        html += `<div><strong>New path:</strong></div>`;
        html += `<code style="font-size:10px;color:var(--txt);display:block;margin-top:4px;word-break:break-all">${esc(m.new_path || "")}</code>`;
        html += `</div>`;
        
        html += `<div style="margin-top:12px;color:var(--txt3);font-size:11px"><strong>Match score:</strong> ${Math.round(m.score * 100)}%`;
        if (m.score < LOW_CONFIDENCE) html += ` <span style="color:var(--amber)">(low — review)</span>`;
        html += `</div>`;

        // Why this match was chosen — per-metric breakdown (item 7).
        if (Array.isArray(m.score_detail) && m.score_detail.length) {
            html += `<div style="margin-top:8px"><strong style="font-size:11px;color:var(--txt3)">Why this match</strong>`;
            html += `<table style="width:100%;margin-top:6px;font-size:11px;border-collapse:collapse">`;
            for (const c of m.score_detail) {
                const pct = Math.round(c.value * 100);
                const pos = c.value >= 0;
                const barColor = pos ? "var(--green)" : "var(--red)";
                const barW = Math.min(100, Math.abs(pct));
                html += `<tr>
                    <td style="color:var(--txt2);padding:2px 8px 2px 0;white-space:nowrap">${esc(c.label || c.metric)}</td>
                    <td style="width:100%">
                        <div style="background:var(--glass-hover);border-radius:3px;height:8px;overflow:hidden">
                            <div style="height:100%;width:${barW}%;background:${barColor}"></div>
                        </div>
                    </td>
                    <td style="color:var(--txt3);padding:2px 0 2px 8px;text-align:right;white-space:nowrap">${pct}% ·×${c.weight}</td>
                </tr>`;
            }
            html += `</table></div>`;
        }
        html += `</div>`;

        modalBody.innerHTML = html;
        modalOverlay.classList.remove("hidden");
    },
    
    async selectShow(showId, showName, e) {
        if (e && e.target) {
            e.target.disabled = true;
            e.target.textContent = "Loading...";
        }
        
        modalOverlay.classList.add("hidden");
        status(`Matching against ${showName}…`);
        
        const filesToMatch = window._pendingMatchFiles || [];
        
        try {
            const data = await api("/api/match", {
                method: "POST",
                body: JSON.stringify({
                    files: filesToMatch,
                    datasource: elSource.value,
                    template: elTemplate.value,
                    include_adult: elIncludeAdult.checked,
                    selected_show_id: showId,
                    selected_show_name: showName,
                }),
            });
            
            // Rebuild matchResults
            matchResults = new Array(scannedFiles.length).fill(null);
            const resultMap = new Map();
            for (const r of data.results) {
                resultMap.set(r.original, r);
            }
            for (let i = 0; i < scannedFiles.length; i++) {
                matchResults[i] = resultMap.get(scannedFiles[i].path) || null;
            }

            applyConfidenceGate();
            renderLeft();   // reflect any rows the gate deselected
            renderRight();
            renderGutter();
            btnRename.disabled = !matchResults.some(r => r && r.matched);
            const matched = matchResults.filter(r => r && r.matched).length;
            statusDone(`Matched ${matched} of ${filesToMatch.length} file(s) with ${showName}`);
        } catch (err) {
            statusDone("Match failed: " + err.message);
        }
        
        delete window._pendingMatchFiles;
    },
    
    // ─── Drag & Drop for manual match adjustment ───────────────
    dragStart(e, idx, pane) {
        draggedIdx = idx;
        draggedFrom = pane;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", idx);
        e.target.classList.add("dragging");
    },
    
    dragOver(e, idx, pane) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        
        // Highlight drop target
        if (draggedIdx !== null && draggedIdx !== idx) {
            e.currentTarget.classList.add("drag-over");
        }
    },
    
    drop(e, targetIdx, targetPane) {
        e.preventDefault();
        e.stopPropagation();
        
        if (draggedIdx === null || draggedIdx === targetIdx) return;
        
        // Case 1: Drag from left to right (or right to right) = swap matches
        if (targetPane === "right") {
            // Swap the match results
            const temp = matchResults[draggedIdx];
            matchResults[draggedIdx] = matchResults[targetIdx];
            matchResults[targetIdx] = temp;
            
            renderRight();
            renderGutter();
            
            status(`Remapped file ${draggedIdx + 1} → match ${targetIdx + 1}`);
            setTimeout(() => statusHide(), 2000);
        }
        // Case 2: Drag within left pane = reorder files
        else if (targetPane === "left" && draggedFrom === "left") {
            const [movedFile] = scannedFiles.splice(draggedIdx, 1);
            scannedFiles.splice(targetIdx, 0, movedFile);
            
            const [movedMatch] = matchResults.splice(draggedIdx, 1);
            matchResults.splice(targetIdx, 0, movedMatch);
            
            // Update selectedSet indices
            const newSelected = new Set();
            selectedSet.forEach(i => {
                if (i === draggedIdx) newSelected.add(targetIdx);
                else if (i > draggedIdx && i <= targetIdx) newSelected.add(i - 1);
                else if (i < draggedIdx && i >= targetIdx) newSelected.add(i + 1);
                else newSelected.add(i);
            });
            selectedSet = newSelected;
            
            renderLeft();
            renderRight();
            renderGutter();
        }
    },
    
    dragEnd(e) {
        e.target.classList.remove("dragging");
        document.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
        draggedIdx = null;
        draggedFrom = null;
    },
    
    async undoOperation(operationId) {
        if (!await confirmDialog("Undo this rename operation? The file will be moved back to its original location.", { okText: "Undo" })) return;

        try {
            const data = await api(`/api/undo/${operationId}`, { method: "POST" });
            status(data.message);
            setTimeout(() => statusHide(), 2000);
            
            // Refresh history dialog
            modalOverlay.classList.add("hidden");
            setTimeout(() => showHistory(), 300);
        } catch (err) {
            status(`Undo failed: ${err.message}`);
            setTimeout(() => statusHide(), 3000);
        }
    },
    
    async clearHistory() {
        if (!await confirmDialog("Clear all history? This cannot be undone.", { okText: "Clear History", danger: true })) return;

        try {
            await api("/api/history", { method: "DELETE" });
            modalOverlay.classList.add("hidden");
            status("History cleared");
            setTimeout(() => statusHide(), 1500);
        } catch (err) {
            status(`Failed to clear history: ${err.message}`);
            setTimeout(() => statusHide(), 3000);
        }
    },

    /* ─── Manual rename (FileBot-style inline edit) ────────── */
    startInlineEdit(idx) {
        const f = scannedFiles[idx];
        if (!f) return;

        // Derive stem and extension from the original filename
        const dotPos = f.filename.lastIndexOf(".");
        const ext  = dotPos > 0 ? f.filename.slice(dotPos) : "";         // ".mkv"
        const origStem = dotPos > 0 ? f.filename.slice(0, dotPos) : f.filename;

        // Pre-fill with the existing manual/auto name if available
        const m = matchResults[idx];
        let prefill = origStem;
        if (m && m.matched) {
            const cur = m.new_name || f.filename;
            const curDot = cur.lastIndexOf(".");
            prefill = curDot > 0 ? cur.slice(0, curDot) : cur;
        }

        const rowEl = rightList.querySelector(`.row-item[data-idx="${idx}"]`);
        if (!rowEl || rowEl.classList.contains("editing")) return;

        rowEl.classList.add("editing");
        rowEl.draggable = false;
        rowEl.innerHTML = `
            <div class="row-icon">${fileIcon("edit")}</div>
            <div style="flex:1;min-width:0;display:flex;align-items:center;gap:4px;overflow:hidden">
                <input class="row-edit-input" type="text" spellcheck="false"
                       value="${esc(prefill)}" title="Type a new filename stem — extension is kept automatically">
                <span class="tag" style="flex-shrink:0;color:var(--txt3);font-size:10px">${esc(ext) || "(no ext)"}</span>
            </div>
            <button class="row-edit-confirm" title="Confirm (Enter)">✓</button>
            <button class="row-edit-cancel-btn" title="Cancel (Esc)">✗</button>`;

        const input = rowEl.querySelector(".row-edit-input");
        input.focus();
        input.select();

        const commit  = () => R.commitInlineEdit(idx, input.value, ext);
        const cancel  = () => renderRight();

        input.addEventListener("keydown", e => {
            // Prevent global shortcuts (Delete, Ctrl+A, Esc) from firing while typing
            e.stopPropagation();
            if (e.key === "Enter")  { e.preventDefault(); commit(); }
            if (e.key === "Escape") { e.preventDefault(); cancel(); }
        });
        rowEl.querySelector(".row-edit-confirm").addEventListener("click",     e => { e.stopPropagation(); commit(); });
        rowEl.querySelector(".row-edit-cancel-btn").addEventListener("click",  e => { e.stopPropagation(); cancel(); });

        focusRow(idx);
    },

    commitInlineEdit(idx, rawStem, ext) {
        // Sanitize: strip filesystem-forbidden chars, normalise whitespace, cap length
        const stem = rawStem
            .trim()
            .replace(/[/\\:*?"<>|]/g, "_")   // forbidden on Win/Linux/macOS
            .replace(/\.{2,}/g, ".")           // collapse consecutive dots
            .replace(/^\.+|\.+$/g, "")         // no leading/trailing dot
            .slice(0, 200);

        if (!stem) { renderRight(); return; }   // empty → cancel

        const newFilename = stem + ext;
        const f = scannedFiles[idx];
        const parentDir = f.path.lastIndexOf("/") > 0
            ? f.path.slice(0, f.path.lastIndexOf("/"))
            : ".";
        const newPath = parentDir + "/" + newFilename;

        matchResults[idx] = {
            matched:  true,
            manual:   true,
            score:    1.0,
            original: f.path,
            new_name: newFilename,
            new_path: newPath,
            preview:  newFilename,
            metadata: null,
        };

        renderRight();
        renderGutter();
        btnRename.disabled = !matchResults.some(r => r && r.matched);
        focusRow(idx);

        status(`Manual name set: ${newFilename}`);
        setTimeout(() => statusHide(), 1800);
    },
};

/* ─── Sync scroll between panes ───────────────────────────── */
let scrolling = false;
leftList.addEventListener("scroll", () => {
    if (scrolling) return;
    scrolling = true;
    rightList.scrollTop = leftList.scrollTop;
    requestAnimationFrame(() => { scrolling = false; });
});
rightList.addEventListener("scroll", () => {
    if (scrolling) return;
    scrolling = true;
    leftList.scrollTop = rightList.scrollTop;
    requestAnimationFrame(() => { scrolling = false; });
});

/* ─── Template presets ────────────────────────────────────── */
document.querySelectorAll(".preset-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        elTemplate.value = btn.dataset.template;
        persistPrefs();
        updateTemplatePreview();
    });
});

/* ─── Template token palette (insert at cursor) ───────────────── */
document.querySelectorAll(".token-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const tok = btn.dataset.token;
        const start = elTemplate.selectionStart ?? elTemplate.value.length;
        const end   = elTemplate.selectionEnd ?? elTemplate.value.length;
        elTemplate.value = elTemplate.value.slice(0, start) + tok + elTemplate.value.slice(end);
        const caret = start + tok.length;
        elTemplate.focus();
        elTemplate.setSelectionRange(caret, caret);
        persistPrefs();
        updateTemplatePreview();
    });
});

/* ─── Bulk selection actions (operate on the left-pane checkboxes) ── */
function bulkSelect(predicate) {
    selectedSet = new Set();
    for (let i = 0; i < scannedFiles.length; i++) {
        if (predicate(matchResults[i], i)) selectedSet.add(i);
    }
    renderLeft();
    renderRight();
}
$id("bulk-matched")?.addEventListener("click", () => bulkSelect(m => !!(m && m.matched)));
$id("bulk-high")?.addEventListener("click", () => bulkSelect(m => !!(m && m.matched && m.score >= 0.6)));
$id("bulk-clear-unmatched")?.addEventListener("click", () => {
    // Deselect rows that have no match; leave matched selections untouched.
    for (let i = 0; i < scannedFiles.length; i++) {
        const m = matchResults[i];
        if (!m || !m.matched) selectedSet.delete(i);
    }
    renderLeft();
    renderRight();
});

/* ─── Live template preview (item 6) ──────────────────────────── */
let _previewTimer = null;
function updateTemplatePreview() {
    const el = $id("template-preview");
    if (!el) return;
    const tpl = elTemplate.value.trim();
    if (!tpl) { el.textContent = ""; return; }
    // Sample = first selected file, else first scanned file, else empty.
    const idx = scannedFiles.findIndex((_, i) => selectedSet.has(i));
    const sample = scannedFiles[idx] || scannedFiles[0] || {};
    clearTimeout(_previewTimer);
    _previewTimer = setTimeout(async () => {
        try {
            const data = await api("/api/preview-template", {
                method: "POST",
                body: JSON.stringify({ template: tpl, sample }),
            });
            el.textContent = data.preview ? "→ " + data.preview : "";
            el.classList.remove("preview-error");
        } catch (err) {
            el.textContent = "⚠ " + err.message;
            el.classList.add("preview-error");
        }
    }, 250);
}
elTemplate.addEventListener("input", () => { persistPrefs(); updateTemplatePreview(); });

/* ─── Keyboard shortcuts ──────────────────────────────────── */
document.addEventListener("keydown", e => {
    // F2: edit focused row name manually
    if (e.key === "F2" && focusedIdx !== null && scannedFiles.length > 0) {
        e.preventDefault();
        R.startInlineEdit(focusedIdx);
        return;
    }
    // Delete: remove selected files (skip when editing inline)
    if (e.key === "Delete" && scannedFiles.length > 0 && !document.querySelector(".row-edit-input")) {
        e.preventDefault();
        removeSelected();
    }
    // Ctrl+A: select all
    if (e.key === "a" && e.ctrlKey && scannedFiles.length > 0 && !document.querySelector(".row-edit-input")) {
        e.preventDefault();
        selectedSet = new Set(scannedFiles.map((_, i) => i));
        renderLeft();
    }
    // Escape: close modal
    if (e.key === "Escape") {
        modalOverlay.classList.add("hidden");
    }
});

/* Focus a single row by index (syncs both panes visually). */
function focusRow(idx) {
    document.querySelectorAll(".row-item.row-focused").forEach(el => el.classList.remove("row-focused"));
    focusedIdx = idx;
    if (idx === null) return;
    leftList.querySelector(`.row-item[data-idx="${idx}"]`)?.classList.add("row-focused");
    rightList.querySelector(`.row-item[data-idx="${idx}"]`)?.classList.add("row-focused");
}

/* Remove one file by index and advance keyboard focus to the next row. */
function removeSingleFile(idx) {
    if (idx < 0 || idx >= scannedFiles.length) return;

    // Determine which index to focus after removal
    const nextFocus = scannedFiles.length === 1
        ? null
        : idx < scannedFiles.length - 1 ? idx : idx - 1;

    scannedFiles.splice(idx, 1);
    matchResults.splice(idx, 1);

    // Remap selectedSet indices after splice
    const newSelected = new Set();
    selectedSet.forEach(i => {
        if (i < idx) newSelected.add(i);
        else if (i > idx) newSelected.add(i - 1);
        // i === idx: removed — drop it
    });
    selectedSet = newSelected;
    focusedIdx = nextFocus; // set before render so restoreRowFocus() picks it up

    renderLeft();
    renderRight();
    renderGutter();
    leftCount.textContent = scannedFiles.length;
    btnMatch.disabled = scannedFiles.length === 0;
    btnRename.disabled = !matchResults.some(r => r && r.matched);
}

function removeSelected() {
    if (selectedSet.size === 0) return;
    focusedIdx = null;
    const toRemove = Array.from(selectedSet).sort((a, b) => b - a);
    for (const idx of toRemove) {
        scannedFiles.splice(idx, 1);
        matchResults.splice(idx, 1);
    }
    selectedSet.clear();
    renderLeft();
    renderRight();
    renderGutter();
    leftCount.textContent = scannedFiles.length;
    btnMatch.disabled = scannedFiles.length === 0;
    btnRename.disabled = !matchResults.some(r => r && r.matched);
}

/* ─── Modal ───────────────────────────────────────────────── */
modalClose.addEventListener("click", () => modalOverlay.classList.add("hidden"));
modalOverlay.addEventListener("click", e => {
    if (e.target === modalOverlay) modalOverlay.classList.add("hidden");
});

/* ─── File icon SVG helper ────────────────────────────────── */
function fileIcon(type) {
    if (type === "series") {
        return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" stroke-width="2">
            <rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/>
        </svg>`;
    }
    if (type === "movie") {
        return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2">
            <rect x="2" y="2" width="20" height="20" rx="3"/><circle cx="12" cy="12" r="4"/>
        </svg>`;
    }
    if (type === "edit") {
        return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>`;
    }
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2">
        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>
    </svg>`;
}

/* ─── Init ────────────────────────────────────────────────── */
renderLeft();             // build-aware empty state (replaces the static drop-zone)
updateTemplatePreview();  // show a preview for the restored/default template

})();
