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

// Confidence thresholds. These are STARTUP FALLBACKS only — the real values
// come from GET /api/settings (backend LOW_CONFIDENCE_THRESHOLD /
// REVIEW_CONFIDENCE_THRESHOLD, env-overridable per deployment), adopted in
// checkKeysOnStartup() so every build target shares one source of truth.
// low: at/below this a match is never auto-selected for renaming.
// review: below this a match shows the review triangle / footer count.
let LOW_CONFIDENCE = 0.4;
let REVIEW_CONFIDENCE = 0.6;

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

const btnReview        = $id("btn-review");
const footerHintAction = $id("footer-hint-action");
const footerReady      = $id("footer-ready");
const statHigh         = $id("stat-high");
const statReview       = $id("stat-review");

/* View filter for the dual pane (All / Matched / Unmatched).
   Filters what is VISIBLE only — selection (checkboxes) decides what renames. */
let viewFilter = "all";
function rowHiddenCls(i) {
    if (viewFilter === "all") return "";
    const matched = !!(matchResults[i] && matchResults[i].matched);
    return (viewFilter === "matched") === matched ? "" : " row-hidden";
}

/* Footer action bar: live "N of M files ready", Rename label, Review button. */
function updateFooter() {
    const total = scannedFiles.length;
    let ready = 0, review = 0, hasMatch = false;
    for (let i = 0; i < scannedFiles.length; i++) {
        const m = matchResults[i];
        if (m && m.matched) {
            hasMatch = true;
            if (selectedSet.has(i)) ready++;
            if (!m.manual && m.score < REVIEW_CONFIDENCE) review++;
        }
    }
    btnRename.disabled = ready === 0;
    const label = btnRename.querySelector(".btn-label");
    if (label) label.textContent = ready > 0 ? `Rename ${ready} file${ready === 1 ? "" : "s"}` : "Rename";
    if (btnReview) {
        btnReview.classList.toggle("hidden", review === 0);
        btnReview.textContent = `Review ${review} match${review === 1 ? "" : "es"}`;
    }
    if (footerReady) {
        footerReady.textContent = hasMatch
            ? `${ready} of ${total} files ready.`
            : (total > 0 ? `${total} file${total === 1 ? "" : "s"} scanned.` : "");
    }
    if (statHigh && statReview) {
        const high = matchResults.filter(r => r && r.matched && (r.manual || r.score >= REVIEW_CONFIDENCE)).length;
        statHigh.classList.toggle("hidden", high === 0);
        statHigh.textContent = `${high} high`;
        statReview.classList.toggle("hidden", review === 0);
        statReview.textContent = `${review} review`;
    }
}

/* ─── Start over (brand button) ───────────────────────────── */
/* Bumped by startOver(); async scan/match handlers capture it before their
   await and bail if it changed, so a slow response can't repopulate panes
   the user just cleared. */
let sessionGen = 0;

function startOver() {
    sessionGen++;
    scannedFiles = [];
    matchResults = [];
    selectedSet = new Set();
    focusedIdx = null;
    elScanPath.value = "";
    viewFilter = "all";
    document.querySelectorAll("#view-filter .seg-btn").forEach(b =>
        b.classList.toggle("on", b.dataset.filter === "all"));
    btnMatch.disabled = true;
    btnRename.disabled = true;
    renderLeft();
    renderRight();
    renderGutter();
    updateFooter();
    updateTemplatePreview();   // back to the no-files hint state
    statusHide();
    // Persist the cleared scan path — without this, restorePrefs() resurrects
    // the old folder on the next load and "Start over" looks like it did
    // nothing. (Template/source/action/theme are prefs, not session state;
    // they persist unchanged.)
    persistPrefs();
}
$id("btn-home")?.addEventListener("click", startOver);

/* Jump to the first match that needs review */
btnReview?.addEventListener("click", () => {
    for (let i = 0; i < matchResults.length; i++) {
        const m = matchResults[i];
        if (m && m.matched && !m.manual && m.score < REVIEW_CONFIDENCE) {
            focusRow(i);
            rightList.querySelector(`.row-item[data-idx="${i}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
            break;
        }
    }
});

/* Segmented view filter (left pane header) */
document.querySelectorAll("#view-filter .seg-btn").forEach(b => {
    b.addEventListener("click", () => {
        viewFilter = b.dataset.filter;
        document.querySelectorAll("#view-filter .seg-btn").forEach(x => x.classList.toggle("on", x === b));
        renderLeft();
        renderRight();
    });
});

/* ─── First-run key check ─────────────────────────────────── */
let appSettings = null;   // cached /api/settings (tmdb_enabled, omdb_enabled, …)
(async function checkKeysOnStartup() {
    try {
        const s = await api("/api/settings");
        appSettings = s;
        // Adopt the backend's confidence thresholds (single source of truth;
        // env-overridable per deployment). Fallback literals above cover the
        // brief window before this resolves and offline/startup races.
        if (typeof s.low_confidence === "number") LOW_CONFIDENCE = s.low_confidence;
        if (typeof s.review_confidence === "number") REVIEW_CONFIDENCE = s.review_confidence;
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

/* ─── Drag & Drop (whole window) ──────────────────────────── */
/* External OS drags are accepted ANYWHERE in the window — a drop shouldn't
   miss just because it landed outside the left pane. Internal row drags
   (draggedIdx !== null) are owned by the row handlers in R; the document
   handlers ignore them. Everything hangs off document so re-rendering the
   panes' innerHTML can never detach a listener mid-drag. */
let dragCounter = 0;

function isFileDrag(e) {
    // During dragenter/dragover only the TYPES are readable, not the data.
    const types = (e.dataTransfer && e.dataTransfer.types) || [];
    return Array.from(types).some(t => t === "Files" || t === "text/uri-list");
}

function clearDragHighlight() {
    dragCounter = 0;
    const dz = $id("drop-zone");
    if (dz) dz.classList.remove("drag-hover");
    document.body.classList.remove("dragging-over");
}

document.addEventListener("dragenter", e => {
    e.preventDefault();
    if (!isFileDrag(e)) return;   // internal row drag — no highlight
    dragCounter++;
    const dz = $id("drop-zone");
    if (dz) dz.classList.add("drag-hover");
    document.body.classList.add("dragging-over");
});
document.addEventListener("dragleave", e => {
    e.preventDefault();
    if (!isFileDrag(e)) return;
    if (--dragCounter <= 0) clearDragHighlight();
});
document.addEventListener("dragover", e => {
    // Must be prevented continuously or the browser refuses the drop.
    e.preventDefault();
    // Don't clobber the "move" effect the row handlers set for internal drags.
    if (isFileDrag(e) && e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
// A cancelled drag (Esc / dropped outside the window) fires dragend but not
// necessarily dragleave — without this the highlight ring sticks forever.
document.addEventListener("dragend", clearDragHighlight);
document.addEventListener("drop", e => {
    e.preventDefault();
    clearDragHighlight();
    if (!isFileDrag(e)) return;   // internal row drag that missed a row
    // A modal (browse / history / settings) is open — don't scan behind it.
    if (!modalOverlay.classList.contains("hidden")) return;
    handleExternalDrop(e);
});

function handleExternalDrop(e) {
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
}

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
        const gen = sessionGen;
        try {
            const data = await api("/api/scan-batch", {
                method: "POST",
                body: JSON.stringify({ paths: fullPaths }),
            });
            if (gen !== sessionGen) return;   // user hit "start over" meanwhile
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
        // Status/genre chips — what actually distinguishes same-named
        // reboots (TVmaze supplies them; TMDb candidates send empty fields).
        const chipParts = [c.status, ...(Array.isArray(c.genres) ? c.genres : [])].filter(Boolean);
        const chips = chipParts.length
            ? `<div style="margin-top:3px">${chipParts.map(t => `<span class="tag">${esc(t)}</span>`).join(" ")}</div>`
            : "";

        html += `<div class="candidate-item" data-id="${c.id}" data-name="${esc(c.name)}">
            ${poster}
            <div style="flex:1;min-width:0;">
                <div style="font-weight:500;font-size:12px;color:var(--txt)">${esc(c.name)}${year}${rating}</div>
                ${chips}
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
    const gen = sessionGen;

    // If a single directory was dropped, scan it
    // If multiple files, scan each one individually
    // We'll try scanning the first path as a directory first
    try {
        // Collect into a local first — only committed to scannedFiles after
        // the sessionGen check below, so "start over" can't be overwritten.
        let files;
        // If it's a single folder
        if (paths.length === 1) {
            const data = await api("/api/scan", {
                method: "POST",
                body: JSON.stringify({ path: paths[0], recursive: elRecursive.checked }),
            });
            files = data.files;
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
            files = allFiles;
        }
        if (gen !== sessionGen) return;   // user hit "start over" meanwhile

        scannedFiles = files;
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

/* ─── Action hint (footer bar) ────────────────────────────── */
/* Fallback hints — overwritten by the server's copy from GET /api/actions
   (initActions), so backend and UI text can't drift. */
const ACTION_HINTS = {
    rename:   "Rename in place — files stay in their current folders.",
    test:     "Dry run — nothing changes on disk.",
    move:     "Move relocates files into new folders — they leave this location.",
    keeplink: "Moves the file and leaves a symlink at the old path — torrents keep seeding. Not for SMB/FAT.",
    copy:     "Copy keeps originals and creates renamed copies.",
    hardlink: "Hard link — same file, second name. Same filesystem only.",
    symlink:  "Symlink points back to the original. Not for SMB/FAT.",
};

function updateActionHint() {
    if (!footerHintAction) return;
    const hint = ACTION_HINTS[elAction.value];
    footerHintAction.textContent = hint || "";
    footerHintAction.className = "action-hint-text action-hint-" + elAction.value;
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
// "aurora" was removed in the flat-UI redesign; applyTheme() maps any
// persisted unknown theme (incl. aurora) back to "dark".
const VALID_THEMES = ["dark", "light"];

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

/* Rebuild the Action dropdown from the backend (GET /api/actions) so the
   option list always mirrors the RenameAction enum — the hardcoded HTML list
   is only a fallback for offline/startup races. Runs after restorePrefs(),
   preserving the user's saved action across the rebuild. */
(async function initActions() {
    let actions;
    try {
        actions = await api("/api/actions");
    } catch { return; }   // backend unreachable — keep the static fallback list
    if (!Array.isArray(actions) || actions.length === 0) return;

    const saved = elAction.value;
    elAction.innerHTML = "";
    for (const a of actions) {
        if (!a || typeof a.value !== "string") continue;
        const o = document.createElement("option");
        o.value = a.value;
        o.textContent = a.label || a.value;
        elAction.appendChild(o);
        if (a.hint) ACTION_HINTS[a.value] = a.hint;
    }
    if ([...elAction.options].some(o => o.value === saved)) elAction.value = saved;
    updateActionHint();
})();


elScanPath.addEventListener("keydown", e => { if (e.key === "Enter") doScan(); });
// The toolbar Scan button previously had no handler — clicking it did nothing
// (scan only worked via Enter in the path field or the Browse dialog). Wire it.
btnScan.addEventListener("click", doScan);

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
    const gen = sessionGen;
    try {
        const data = await api("/api/scan-batch", {
            method: "POST",
            // Honor the "Include subfolders" toggle for folder selections too.
            body: JSON.stringify({ paths, recursive: elRecursive.checked }),
        });
        if (gen !== sessionGen) return;   // user hit "start over" meanwhile
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
    // Wide, height-aware modal variant; removed again by R.closeModal().
    modalOverlay.classList.add("modal-wide");

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
        $id("browse-cancel").addEventListener("click", () => R.closeModal());
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

        // Row click: directories NAVIGATE (like every file manager); selecting a
        // directory requires an explicit click on its checkbox. The old behavior
        // (click = toggle checkbox) silently selected huge folders while browsing,
        // and "Scan N Selected" then crawled entire NAS trees the user never
        // meant to include. Files still toggle on click.
        listEl.querySelectorAll(".browser-item").forEach(el => {
            el.addEventListener("click", e => {
                if (e.target.tagName === "INPUT") return;
                if (el.dataset.isDir === "true") { loadPath(el.dataset.path); return; }
                const cb = el.querySelector('input[type="checkbox"]');
                if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); }
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
        R.closeModal();
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
    const gen = sessionGen;

    try {
        const data = await api("/api/scan", {
            method: "POST",
            body: JSON.stringify({ path, recursive: elRecursive.checked }),
        });
        if (gen !== sessionGen) return;   // user hit "start over" meanwhile
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

/* Poll the backend's live match snapshot and render determinate progress:
   "Matching group 3/7: The Wire (25 files)…" with the bar filling. Returns
   the interval id — callers clearInterval() it when the match settles. Poll
   failures are non-fatal (the indeterminate bar simply keeps animating). */
function startMatchProgressTicker() {
    return setInterval(async () => {
        try {
            const p = await api("/api/match-progress");
            if (p.active && p.total > 0) {
                const files = p.files ? ` (${p.files} file${p.files === 1 ? "" : "s"})` : "";
                statusText.textContent = `Matching group ${p.current}/${p.total}: ${p.group}${files}…`;
                progressFill.classList.remove("loading");
                progressFill.style.width = Math.round(100 * p.current / p.total) + "%";
            }
        } catch { /* transient poll failure — keep last rendered state */ }
    }, 1000);
}

/* Rename twin of startMatchProgressTicker — "Renaming 3/12: file.mkv…".
   Kept as its own tiny function (labels and fields differ) rather than one
   branchy parameterized ticker. The backend runs renames in a worker thread,
   so this poll stays live even mid-copy of a huge file. */
function startRenameProgressTicker() {
    return setInterval(async () => {
        try {
            const p = await api("/api/rename-progress");
            if (p.active && p.total > 0) {
                statusText.textContent = `Renaming ${p.current}/${p.total}: ${p.file}…`;
                progressFill.classList.remove("loading");
                progressFill.style.width = Math.round(100 * p.current / p.total) + "%";
            }
        } catch { /* transient poll failure — keep last rendered state */ }
    }, 1000);
}

async function doMatch() {
    if (scannedFiles.length === 0) return;

    const filesToMatch = scannedFiles.filter((_, i) => selectedSet.has(i));
    if (filesToMatch.length === 0) return;

    // /api/match is a single request (kept that way to preserve cross-file
    // grouping + subtitle pairing + conflict detection). Real progress comes
    // from polling GET /api/match-progress once a second — the backend updates
    // a snapshot as it works through each detected group.
    const src = elSource.value.toUpperCase();
    status(`Matching ${filesToMatch.length} file(s) against ${src}…`);
    const ticker = startMatchProgressTicker();
    btnMatch.disabled = true;
    const gen = sessionGen;

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
        if (gen !== sessionGen) return;   // user hit "start over" meanwhile
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
        updateFooter();
        const matched = matchResults.filter(r => r && r.matched).length;

        // Status line: conflicts and/or source errors, both truthful at once.
        const suffix = [];
        if (data.conflicts && data.conflicts.length > 0) {
            showConflictsDialog(data.conflicts);
            suffix.push(`${data.conflicts.length} conflict(s) found`);
        }
        const srcErrs = Object.entries(data.source_errors || {});
        if (srcErrs.length) {
            suffix.push(srcErrs.map(([s, e]) => `${s.toUpperCase()} error: ${e}`).join("; "));
            // A 401 means the key is invalid/revoked — resurface the key banner
            // at the exact moment it matters.
            if (srcErrs.some(([, e]) => e.includes("401"))) keyBanner.classList.remove("hidden");
        }
        statusDone(`Matched ${matched} of ${filesToMatch.length} file(s)${suffix.length ? " — " + suffix.join(" · ") : ""}`);
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
    const ticker = startRenameProgressTicker();

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
        clearInterval(ticker);
        btnRename.disabled = false;
    }
}

function showRenameResults(data) {
    modalTitle.textContent = `Rename Results — ${data.action}`;
    let html = `<p style="margin-bottom:10px;color:var(--txt2)">
        ${data.success} succeeded, ${data.failed} failed of ${data.total}</p>`;
    // Per-row action: verify where the file landed with one click. Desktop
    // reveals it via the existing shell:showItem IPC; Docker/browser falls
    // back to Copy path — the same graceful degradation the context menu uses.
    const okLabel = canShowInFolder ? "Show in folder" : "Copy path";
    data.results.forEach((r, i) => {
        if (r.success) {
            html += `<div class="res-row">
                <span class="res-icon ok">✓</span>
                <span class="res-text">${esc(r.destination)}</span>
                <button class="glass-btn res-act" data-i="${i}"
                        style="margin-left:auto;flex-shrink:0;padding:3px 10px;font-size:10px">${okLabel}</button>
            </div>`;
        } else {
            html += `<div class="res-row">
                <span class="res-icon fail">✗</span>
                <span class="res-text">${esc(r.original)}</span>
                <button class="glass-btn res-act" data-i="${i}"
                        style="margin-left:auto;flex-shrink:0;padding:3px 10px;font-size:10px">Copy error</button>
            </div>
            <div class="res-err">${esc(r.error)}</div>`;
        }
    });
    modalBody.innerHTML = html;
    // Real listeners over data.results — not inline onclick with a quoted
    // path, which would break (and be attribute-injectable) for filenames
    // containing quotes/apostrophes ("Ocean's Eleven").
    modalBody.querySelectorAll(".res-act").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const r = data.results[Number(btn.dataset.i)];
            if (!r) return;
            if (!r.success) {
                R.copyPath(r.error || "unknown error", e);
            } else if (canShowInFolder) {
                R.showInFolderPath(r.destination);
            } else {
                R.copyPath(r.destination, e);
            }
        });
    });
    modalOverlay.classList.remove("hidden");
}

/* ─── Software update: banner, Settings card, restart prompt ──
   One state machine feeds three surfaces:
     - a dismissible banner in the main window (announces a release once),
     - the "Software update" card in Settings (idle → downloading → ready →
       installing → done, plus manual-fallback and error states),
     - a themed in-app restart prompt (replaces the native OS dialog, whose
       "Restart now" read like a system reboot).
   The underlying trust model is untouched: the renderer passes no arguments
   to download/install/restart — the main process owns what happens. */
let updInfo = null;       // last /api/version payload
let updPhase = "idle";    // idle | downloading | ready | manual | installing | done | error
let updResult = null;     // downloadUpdate() result ({name, pkgType, …})
let updError = "";
let updNote = "";         // transient note (e.g. cancelled authorization)

function updCanAutoDl() {
    return isElectron && window.electronAPI && typeof window.electronAPI.downloadUpdate === "function";
}
function updCanInstall() {
    return isElectron && window.electronAPI && typeof window.electronAPI.installUpdate === "function";
}

function renderUpdateCard() {
    const slot = $id("update-card-slot");
    if (!slot) return;                    // Settings not open — state persists for next open
    const v = updInfo;
    if (!v || !v.version) { slot.innerHTML = ""; return; }
    const upd = v.update;
    const relUrl = (upd && upd.url) || "https://github.com/aiulian25/cinesort/releases";

    // Up to date — the quiet default.
    if (!upd || !upd.latest) {
        slot.innerHTML = `
            <div class="update-card update-row">
                <span class="update-chip ok">✓ Up to date</span>
                <span style="font-weight:650">CineSort v${esc(v.version)}</span>
                <span class="up-tiny" style="flex:1">checks once per day</span>
                <a class="up-tiny" href="${esc(relUrl)}" target="_blank" rel="noopener noreferrer">Releases on GitHub</a>
            </div>`;
        return;
    }

    const latest = esc(upd.latest);
    const whatsNew = `<a href="${esc(relUrl)}" target="_blank" rel="noopener noreferrer">What's new</a>`;

    // Docker / plain browser: same card, pull command instead of buttons.
    if (!updCanAutoDl()) {
        slot.innerHTML = `
            <div class="update-card highlight">
                <h4><span class="update-chip new">New</span> CineSort v${latest} is available</h4>
                <div class="up-muted">You're on v${esc(v.version)} · ${whatsNew}</div>
                ${isElectron ? "" : `<div class="up-tiny" style="margin-top:6px">Update with: <code>docker compose pull &amp;&amp; docker compose up -d</code></div>`}
            </div>`;
        return;
    }

    let html = "";
    if (updPhase === "downloading") {
        html = `
            <div class="update-card highlight">
                <h4>Downloading CineSort v${latest}…</h4>
                <div class="update-bar"><i id="upd-bar-fill"></i></div>
                <div class="update-row">
                    <span class="up-muted" id="upd-bytes" style="flex:1;margin-top:0">Starting download… · from github.com</span>
                    <span class="up-muted" id="upd-pct" style="margin-top:0">0%</span>
                </div>
            </div>`;
    } else if (updPhase === "ready") {
        const appimage = updResult && updResult.pkgType === "appimage";
        html = `
            <div class="update-card highlight">
                <div class="update-row">
                    <div style="flex:1;min-width:0">
                        <h4><span style="color:var(--green)">✓</span> Downloaded and verified</h4>
                        <div class="up-muted">sha256 checksum matches the GitHub release · <span class="mono">${esc(updResult && updResult.name || "")}</span></div>
                        <div class="up-tiny">${appimage
                            ? "Replaced in place — no password needed."
                            : "Your system will ask for your password — the package manager does the actual install."}</div>
                        ${updNote ? `<div class="up-tiny" style="color:var(--amber)">${esc(updNote)}</div>` : ""}
                    </div>
                    <button class="glass-btn btn-scan" id="btn-upd-install" style="flex-shrink:0">Install update</button>
                </div>
            </div>`;
    } else if (updPhase === "installing") {
        html = `
            <div class="update-card highlight">
                <h4>Installing v${latest}…</h4>
                <div class="update-bar indet"><i></i></div>
                <div class="up-muted">Waiting for your authorization, then the package manager installs the update. Nothing runs as root inside CineSort.</div>
            </div>`;
    } else if (updPhase === "done") {
        html = `
            <div class="update-card highlight">
                <div class="update-row">
                    <div style="flex:1">
                        <h4><span style="color:var(--green)">✓</span> Update v${latest} installed</h4>
                        <div class="up-muted">Restart CineSort to start using it. Your files, history and settings are untouched.</div>
                    </div>
                    <button class="glass-btn btn-scan" id="btn-upd-restart" style="flex-shrink:0">Restart CineSort</button>
                </div>
            </div>`;
    } else if (updPhase === "manual") {
        const r = updResult || {};
        const hint = r.pkgType === "deb" ? `sudo apt install ./Downloads/${esc(r.name || "")}`
                   : r.pkgType === "rpm" ? `sudo dnf install ./Downloads/${esc(r.name || "")}`
                   : "It is already executable — double-click to run the new version.";
        html = `
            <div class="update-card">
                <h4><span style="color:var(--green)">✓</span> Downloaded and verified</h4>
                <div class="up-muted">Saved <span class="mono">${esc(r.name || "")}</span> to your Downloads folder (opened in your file manager).</div>
                <div class="up-tiny">Install it with: <code>${hint}</code></div>
            </div>`;
    } else if (updPhase === "error") {
        html = `
            <div class="update-card error">
                <div class="update-row">
                    <div style="flex:1;min-width:0">
                        <h4><span style="color:var(--red)">✕</span> Update didn't finish</h4>
                        <div class="up-muted">${esc(updError || "unknown error")}</div>
                        ${updResult && updResult.name ? `<div class="up-tiny">The verified package is in your Downloads folder (<span class="mono">${esc(updResult.name)}</span>) if you prefer to install it yourself.</div>` : ""}
                    </div>
                    <button class="glass-btn" id="btn-upd-retry" style="flex-shrink:0">Try again</button>
                </div>
            </div>`;
    } else {
        // idle — update available.
        html = `
            <div class="update-card highlight">
                <div class="update-row">
                    <div style="flex:1;min-width:0">
                        <h4><span class="update-chip new">New</span> CineSort v${latest} is available</h4>
                        <div class="up-muted">You're on v${esc(v.version)} · ${whatsNew} · verified download from GitHub</div>
                    </div>
                    <button class="glass-btn btn-scan" id="btn-upd-download" style="flex-shrink:0">Download update</button>
                </div>
            </div>`;
    }
    slot.innerHTML = html;
    $id("btn-upd-download")?.addEventListener("click", updDownload);
    $id("btn-upd-retry")?.addEventListener("click", updDownload);
    $id("btn-upd-install")?.addEventListener("click", updInstall);
    $id("btn-upd-restart")?.addEventListener("click", () => {
        window.electronAPI.restartApp && window.electronAPI.restartApp();
    });
}

async function updDownload() {
    updPhase = "downloading"; updError = ""; updNote = "";
    renderUpdateCard();
    window.electronAPI.onUpdateProgress(p => {
        // {pct, transferred, total} from current mains; bare number from older.
        const pct = typeof p === "number" ? p : (p && p.pct) || 0;
        const fill = $id("upd-bar-fill");
        if (fill) fill.style.width = pct + "%";
        const lab = $id("upd-pct");
        if (lab) lab.textContent = pct + "%";
        const bytes = $id("upd-bytes");
        if (bytes && p && typeof p === "object" && p.total) {
            bytes.textContent = `${fmt(p.transferred)} of ${fmt(p.total)} · from github.com`;
        }
    });
    const r = await window.electronAPI.downloadUpdate();
    updResult = r;
    if (r && r.ok && r.canInstall && updCanInstall()) updPhase = "ready";
    else if (r && r.ok) updPhase = "manual";       // no pkexec / older main
    else { updPhase = "error"; updError = "Download failed: " + ((r && r.error) || "unknown error"); }
    renderUpdateCard();
}

async function updInstall() {
    updPhase = "installing"; updNote = "";
    renderUpdateCard();
    const r = await window.electronAPI.installUpdate();
    if (r && r.ok) {
        updPhase = "done";      // main also fires the restart prompt
    } else if (r && r.cancelled) {
        updPhase = "ready";
        updNote = "Authorization was cancelled — nothing was changed.";
    } else {
        updPhase = "error";
        updError = "Install failed: " + ((r && r.error) || "unknown error");
    }
    renderUpdateCard();
}

/* Update banner: one quiet row at the top of the main window, shown once
   per release. Dismiss is remembered per-version — never nags again until
   the NEXT release. */
(async function checkUpdateOnStartup() {
    try {
        const v = await api("/api/version");
        if (!v || !v.version) return;
        updInfo = v;
        const latest = v.update && v.update.latest;
        if (!latest) return;
        if (localStorage.getItem("cinesort.dismissedUpdate") === latest) return;
        $id("update-banner-title").textContent = `CineSort v${latest} is available`;
        $id("update-banner-sub").textContent = updCanAutoDl()
            ? "verified download · installs without a terminal"
            : (isElectron ? "download from GitHub releases" : "one docker pull away");
        $id("update-banner").classList.remove("hidden");
    } catch { /* offline — no banner */ }
})();
$id("update-banner-view").addEventListener("click", () => {
    $id("update-banner").classList.add("hidden");
    showSettings("update");
});
$id("update-banner-dismiss").addEventListener("click", () => {
    const latest = updInfo && updInfo.update && updInfo.update.latest;
    if (latest) localStorage.setItem("cinesort.dismissedUpdate", latest);
    $id("update-banner").classList.add("hidden");
});

/* In-app restart prompt — replaces the native dialog. Shown when the main
   process reports an installed update awaiting a restart (deb/rpm upgrade
   detected on disk, or a replaced AppImage). Asked once; "Restart later"
   is respected — the Settings card keeps the persistent affordance. */
function showRestartModal(info) {
    let overlay = $id("restart-overlay");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "restart-overlay";
        overlay.className = "confirm-overlay hidden";
        document.body.appendChild(overlay);
    }
    const spawnMode = info && info.mode === "spawn";
    const latest = esc((info && info.latest) || "");
    const running = esc((info && info.running) || "");
    overlay.innerHTML = `
        <div class="glass-panel confirm-box restart-box">
            <div class="restart-head">
                <img src="/CineSort.png" class="restart-logo" alt="">
                <div>
                    <div class="restart-title">${spawnMode ? "Ready to switch" : "Update installed"}</div>
                    <div class="restart-sub">CineSort v${latest}${spawnMode ? " · AppImage replaced in place" : ""}</div>
                </div>
            </div>
            <div class="restart-body">${spawnMode
                ? `The new version starts instantly — this window closes and v${latest} opens in its place.`
                : `v${latest} is ready to go — this window is still running v${running}.`}</div>
            <div class="restart-fine">Restarting only reopens CineSort. Your files, history and settings are untouched.</div>
            <div class="restart-actions">
                <button class="glass-btn" id="restart-later">Restart later</button>
                <button class="glass-btn btn-scan" id="restart-now">${spawnMode ? `Start CineSort v${latest}` : "Restart CineSort"}</button>
            </div>
        </div>`;
    overlay.classList.remove("hidden");
    $id("restart-later").addEventListener("click", () => overlay.classList.add("hidden"));
    $id("restart-now").addEventListener("click", () => {
        $id("restart-now").disabled = true;
        window.electronAPI.restartApp && window.electronAPI.restartApp();
    });
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.classList.add("hidden"); });
}
if (isElectron && window.electronAPI && typeof window.electronAPI.onUpdateRestartPending === "function") {
    window.electronAPI.onUpdateRestartPending(showRestartModal);
}

/* ─── Settings ────────────────────────────────────────────── */
const btnSettings = $id("btn-settings");
btnSettings.addEventListener("click", () => showSettings());

async function showSettings(scrollTo) {
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
            </div>
        </div>

        <p style="color:var(--txt3);font-size:11px;margin:16px 0;line-height:1.6">
            Keys are saved to <code class="settings-path">${esc(cfgFile)}</code> and take
            effect immediately — no restart needed. In Docker this lives on the
            <code>/data</code> volume, so keys saved here persist across container
            updates; environment variables in <code>docker-compose.yml</code>
            always take precedence.
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

        <div class="settings-row">
            <div class="settings-label"><span>Metadata language</span></div>
            <p class="settings-hint">
                TMDb language for the titles and overviews used in filenames
                (e.g. <code>de-DE</code>, <code>ro-RO</code>, or just <code>de</code>).
                Empty = English. TVmaze and OMDb are English-only.
            </p>
            <input type="text" id="set-tmdb-lang" class="glass-input mono" style="width:130px"
                   value="${esc(current.tmdb_language || "")}" placeholder="en-US"
                   maxlength="5" autocomplete="off" spellcheck="false">
        </div>

        <div id="update-card-slot"></div>

        <div style="display:flex;gap:8px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
            <button class="glass-btn" onclick="R.closeModal()" style="flex:1">Cancel</button>
            <button class="glass-btn btn-scan" id="settings-save" style="flex:2">Save &amp; Apply</button>
        </div>
        <p id="settings-msg" style="font-size:11px;margin-top:10px;min-height:16px"></p>
        <p id="settings-version" style="font-size:11px;margin-top:4px;color:var(--txt3)"></p>`;

    // Software update card + version footer (best-effort; the modal works
    // without it). One shared endpoint on every build target; only the
    // affordance differs: desktop gets the download+install flow, Docker/
    // browser gets the pull command. States live in renderUpdateCard().
    api("/api/version").then(v => {
        if (!v || !v.version) return;
        updInfo = v;
        renderUpdateCard();
        const el = $id("settings-version");
        if (el) {
            const relUrl = (v.update && v.update.url) || "https://github.com/aiulian25/cinesort/releases";
            el.innerHTML = `CineSort v${esc(v.version)} · <a href="${esc(relUrl)}" target="_blank" rel="noopener noreferrer">Releases on GitHub</a>`;
        }
        if (scrollTo === "update") {
            $id("update-card-slot")?.scrollIntoView({ block: "center" });
        }
    }).catch(() => { /* version line stays empty — non-fatal */ });

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
        const langVal = $id("set-tmdb-lang").value.trim();
        const msg     = $id("settings-msg");

        // Basic client-side length check (mirrors server-side validation)
        for (const [label, val] of [["TMDb key", tmdbVal], ["OMDb key", omdbVal]]) {
            if (val && (val.length < 8 || val.length > 256 || /\s/.test(val))) {
                msg.style.color = "var(--red)";
                msg.textContent = `${label}: must be 8–256 characters with no spaces.`;
                return;
            }
        }
        if (langVal && !/^[a-z]{2}(-[A-Z]{2})?$/.test(langVal)) {
            msg.style.color = "var(--red)";
            msg.textContent = "Language: use an ISO code like de or de-DE (empty = English).";
            return;
        }

        const saveBtn = $id("settings-save");
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
        msg.textContent = "";

        try {
            const result = await api("/api/settings", {
                method: "POST",
                body: JSON.stringify({ tmdb_key: tmdbVal, omdb_key: omdbVal, tmdb_language: langVal }),
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

async function showHistory(limit) {
    // Called from a click listener too, where the arg is an Event — guard.
    limit = typeof limit === "number" ? limit : 50;
    modalTitle.textContent = "Rename History";
    modalBody.innerHTML = `<div style="text-align:center;padding:20px;color:var(--txt3)">Loading...</div>`;
    modalOverlay.classList.remove("hidden");

    try {
        const data = await api(`/api/history?limit=${limit}`);
        const entries = data.history || [];

        if (entries.length === 0) {
            modalBody.innerHTML = `<div style="text-align:center;padding:20px;color:var(--txt3)">No history yet</div>`;
            return;
        }

        const rowHtml = (e) => {
            const time = new Date(e.timestamp).toLocaleString();
            const actionColor = e.action === "move" ? "var(--green)" : e.action === "copy" ? "var(--info)" : "var(--amber)";
            const statusIcon = e.success ? "✓" : "✗";
            const statusColor = e.success ? "var(--green)" : "var(--red)";
            let h = `<div style="padding:10px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px">`;
            h += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">`;
            h += `<div style="display:flex;gap:8px;align-items:center">`;
            h += `<span style="color:${statusColor};font-weight:600">${statusIcon}</span>`;
            h += `<span style="color:${actionColor};font-weight:500;font-size:11px;text-transform:uppercase">${e.action}</span>`;
            h += `<span style="color:var(--txt3);font-size:10px">${time}</span>`;
            h += `</div>`;
            if (e.success && e.action !== "test" && e.action !== "undo") {
                h += `<button class="glass-btn" onclick="R.undoOperation('${e.id}')" style="padding:3px 10px;font-size:10px">Undo</button>`;
            }
            h += `</div>`;
            h += `<div style="font-size:10px;color:var(--txt3);line-height:1.6">`;
            h += `<div>From: ${esc(Path.basename(e.original))}</div>`;
            h += `<div>To: ${esc(Path.basename(e.destination))}</div>`;
            if (e.error) h += `<div style="color:var(--red)">Error: ${esc(e.error)}</div>`;
            h += `</div>`;
            h += `</div>`;
            return h;
        };

        // Group CONSECUTIVE entries sharing a batch_id (one Rename click).
        const groups = [];
        for (const e of entries) {
            const last = groups[groups.length - 1];
            if (e.batch_id && last && last.batchId === e.batch_id) {
                last.entries.push(e);
            } else {
                groups.push({ batchId: e.batch_id || null, entries: [e] });
            }
        }

        let html = `<div style="max-height:400px;overflow-y:auto;display:flex;flex-direction:column;gap:8px">`;
        for (const g of groups) {
            if (g.batchId && g.entries.length >= 2) {
                const first = g.entries[0];
                const undoable = g.entries.filter(
                    e => e.success && e.action !== "test" && e.action !== "undo").length;
                html += `<div style="border:1px solid var(--border);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px">`;
                html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:0 2px">`;
                html += `<div style="display:flex;gap:8px;align-items:center">`;
                html += `<span style="color:var(--txt);font-weight:600;font-size:11.5px">Batch — ${g.entries.length} files</span>`;
                html += `<span style="color:var(--txt3);font-size:10px">${new Date(first.timestamp).toLocaleString()}</span>`;
                html += `</div>`;
                if (undoable > 0) {
                    html += `<button class="glass-btn" onclick="R.undoBatch('${esc(g.batchId)}')" style="padding:3px 10px;font-size:10px">Undo all (${undoable})</button>`;
                }
                html += `</div>`;
                html += g.entries.map(rowHtml).join("");
                html += `</div>`;
            } else {
                html += g.entries.map(rowHtml).join("");
            }
        }
        html += `</div>`;

        html += `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:flex;gap:8px">`;
        if (entries.length === limit && limit < 1000) {
            html += `<button class="glass-btn" onclick="R.showAllHistory()" style="flex:1;font-size:11px">Show all history</button>`;
        }
        html += `<button class="glass-btn" onclick="R.clearHistory()" style="flex:1;font-size:11px">Clear History</button>`;
        html += `<button class="glass-btn" onclick="R.closeModal()" style="flex:1;font-size:11px">Close</button>`;
        html += `</div>`;

        modalBody.innerHTML = html;
    } catch (err) {
        modalBody.innerHTML = `<div style="text-align:center;padding:20px;color:var(--red)">Failed to load history: ${esc(err.message)}</div>`;
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
        const dimCls = selectedSet.has(i) ? "" : " row-dim";
        const sizeTag = f.size ? `<span class="tag tag-size" title="File size">${fmt(f.size)}</span>` : "";
        const musicTag = f.media_type === "music" ? `<span class="tag music" title="Audio file — use the MusicBrainz source">♪</span>` : "";
        // Detection details (type, SxE, quality) live in the row tooltip and
        // the "View metadata" dialog; rows stay clean: checkbox + name + size.
        const tip = [f.path,
                     f.media_type === "series" ? "TV" : f.media_type === "movie" ? "Film" : f.media_type === "music" ? "Music" : "",
                     f.season != null ? `S${String(f.season).padStart(2,"0")}E${String(f.episode).padStart(2,"0")}` : "",
                     f.video_format || ""].filter(Boolean).join("  ·  ");

        html += `<div class="row-item${rowHiddenCls(i)}${dimCls}" data-idx="${i}" draggable="true"
                      role="option" tabindex="-1" aria-selected="${selectedSet.has(i)}"
                      aria-label="${esc(f.filename)}"
                      onmouseenter="R.hoverRow(${i})" onmouseleave="R.unhoverRow(${i})"
                      oncontextmenu="R.showContextMenu(event, ${i}, 'left')"
                      ondragstart="R.dragStart(event, ${i}, 'left')"
                      ondragover="R.dragOver(event, ${i}, 'left')"
                      ondrop="R.drop(event, ${i}, 'left')"
                      ondragend="R.dragEnd(event)">
            <div class="row-cb"><input type="checkbox" ${checked} data-idx="${i}" aria-label="Select ${esc(f.filename)}"></div>
            <span class="row-text original" title="${esc(tip)}">${esc(f.filename)}</span>
            <div class="row-tags">${musicTag}${sizeTag}</div>
        </div>`;
    }
    leftList.innerHTML = html;

    // Checkbox listeners
    leftList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener("change", e => {
            const idx = parseInt(e.target.dataset.idx);
            if (e.target.checked) selectedSet.add(idx);
            else selectedSet.delete(idx);
            e.target.closest(".row-item")?.classList.toggle("row-dim", !e.target.checked);
            updateFooter();
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

    updateFooter();
}

/* ─── Render Right Pane (New Names) ───────────────────────── */
const ICON_OK   = `<svg class="ric ok" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-label="High confidence"><path d="M20 6 9 17l-5-5"/></svg>`;
const ICON_REV  = `<svg class="ric rev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-label="Needs review"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>`;
const ICON_NONE = `<svg class="ric none" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-label="No match"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`;
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
        // Show file size on every result row — matched OR not — so duplicates can
        // be compared and the right copy kept. Source: scannedFiles[i].size (already
        // returned by /api/scan and /api/scan-batch).
        const fsize = scannedFiles[i]?.size;
        const sizeTag = fsize ? `<span class="tag tag-size" title="File size">${fmt(fsize)}</span>` : "";

        /* ── Not yet attempted (scan done, match not run) ── */
        if (!m) {
            html += `<div class="row-item${rowHiddenCls(i)}" data-idx="${i}"
                          onmouseenter="R.hoverRow(${i})" onmouseleave="R.unhoverRow(${i})"
                          oncontextmenu="R.showContextMenu(event, ${i}, 'right')"
                          ondblclick="R.startInlineEdit(${i})">
                <span class="row-text unmatched">—</span>
                <div class="row-tags">${sizeTag}</div>
                <button class="row-edit-btn" title="Set name manually (double-click or F2)"
                        onclick="event.stopPropagation();R.startInlineEdit(${i})">${PENCIL_SVG}</button>
            </div>`;
            continue;
        }

        /* ── Auto-matched or manually named ── */
        if (m.matched) {
            const isManual = !!m.manual;
            // Status icon replaces the old %-score tag: check = high confidence
            // or manual, triangle = needs review. Exact score + per-metric
            // breakdown remain in the right-click "View metadata" dialog.
            const isHigh = isManual || m.score >= REVIEW_CONFIDENCE;
            const icon = isHigh ? ICON_OK : ICON_REV;
            const manualTag = isManual ? `<span class="tag manual">manual</span>` : "";

            // For rename (in-place) show only the filename, not the full template path
            const displayName = elAction.value === "rename"
                ? (m.new_name || "")
                : (m.preview || m.new_name || "");

            // Rich tooltip: full path + matched show/episode metadata
            let tip = m.new_path || displayName;
            if (!isManual && m.metadata?.show) {
                tip += `\n${m.metadata.show} • S${String(m.metadata.season||0).padStart(2,"0")}E${String(m.metadata.episode||0).padStart(2,"0")}`;
                if (m.metadata.title) tip += ` • ${m.metadata.title}`;
            } else if (!isManual && m.metadata?.title) {
                tip += `\n${m.metadata.title}${m.metadata.year ? " (" + m.metadata.year + ")" : ""}`;
            }
            tip += `\nConfidence: ${Math.round(m.score * 100)}%`;

            html += `<div class="row-item${rowHiddenCls(i)}" data-idx="${i}" draggable="true"
                          onmouseenter="R.hoverRow(${i})" onmouseleave="R.unhoverRow(${i})"
                          oncontextmenu="R.showContextMenu(event, ${i}, 'right')"
                          ondragstart="R.dragStart(event, ${i}, 'right')"
                          ondragover="R.dragOver(event, ${i}, 'right')"
                          ondrop="R.drop(event, ${i}, 'right')"
                          ondragend="R.dragEnd(event)"
                          ondblclick="R.startInlineEdit(${i})">
                ${icon}
                <span class="row-text newname" title="${esc(tip)}">${esc(displayName)}</span>
                <div class="row-tags">
                    ${manualTag}
                    ${sizeTag}
                    <button class="row-edit-btn" title="Edit name (double-click or F2)"
                            onclick="event.stopPropagation();R.startInlineEdit(${i})">${PENCIL_SVG}</button>
                </div>
            </div>`;
            continue;
        }

        /* ── Match attempted, failed → prominent edit CTA ── */
        html += `<div class="row-item row-unmatched-cta${rowHiddenCls(i)}" data-idx="${i}"
                      onmouseenter="R.hoverRow(${i})" onmouseleave="R.unhoverRow(${i})"
                      oncontextmenu="R.showContextMenu(event, ${i}, 'right')"
                      ondblclick="R.startInlineEdit(${i})">
            ${ICON_NONE}
            <span class="row-text unmatched" title="${esc(m.reason || "")}">${esc(m.reason || "No match — name manually")}</span>
            <div class="row-tags">${sizeTag}</div>
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

    updateFooter();
}

/* ─── Render Gutter Arrows ────────────────────────────────── */
function renderGutter() {
    // The arrow gutter was removed in the flat-UI redesign (match state is
    // shown per-row in the right pane). Kept as a guarded no-op because it is
    // called from every render path.
    if (!gutter) return;
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
        html += `<div class="ctx-item" onclick="R.searchMetadata(${idx})">🔍 Search metadata…</div>`;
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
    closeModal() {
        modalOverlay.classList.add("hidden");
        modalOverlay.classList.remove("modal-wide");   // reset the browser's wide variant
    },
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
    // Path-based variant for the Rename Results modal: scannedFiles is
    // already cleared after a successful rename, so an index can't be used —
    // the result rows carry the destination path directly.
    showInFolderPath(path) {
        if (!canShowInFolder || typeof path !== "string" || !path) return;
        window.electronAPI.showInFolder(path);
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
        updateFooter();
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
        // Which provider supplied the match — "(fallback)" when the selected
        // source found nothing and the other TV source stepped in. Labeled
        // "Metadata source" because "Source" below is the release tag (BluRay…).
        if (m.metadata?.datasource) {
            html += `<div><strong>Metadata source:</strong> ${esc(m.metadata.datasource.toUpperCase())}${m.metadata.fallback ? " (fallback)" : ""}</div>`;
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
        
        if (m.reason) {
            html += `<div style="margin-top:12px;color:var(--amber);font-size:11px"><strong>Note:</strong> ${esc(m.reason)}</div>`;
        }
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
    
    /* ─── Manual metadata search (wires the previously-dead /api/search) ── */
    searchMetadata(idx) {
        hideContextMenu();
        const f = scannedFiles[idx];
        if (!f) return;

        modalTitle.textContent = "Search Metadata";
        const isTv = f.media_type !== "movie";
        const imdbRow = (appSettings && appSettings.omdb_enabled)
            ? `<div style="display:flex;gap:6px;align-items:center;margin-top:8px">
                   <input type="text" id="search-imdb" class="glass-input mono" style="flex:1"
                          placeholder="…or exact IMDb ID (tt1234567)" spellcheck="false" maxlength="12">
               </div>`
            : "";

        modalBody.innerHTML = `
            <p style="color:var(--txt2);font-size:12px;margin-bottom:10px">
                Search for the correct title, then pick a result to re-match
                <code>${esc(f.filename)}</code>.
            </p>
            <div style="display:flex;gap:6px;align-items:center">
                <input type="text" id="search-q" class="glass-input" style="flex:1"
                       value="${esc(f.clean_name || "")}" spellcheck="false" placeholder="Title…">
                <input type="text" id="search-year" class="glass-input" style="width:74px"
                       value="${f.year || ""}" placeholder="Year" maxlength="4" inputmode="numeric">
                <select id="search-type" class="glass-select" style="width:104px">
                    <option value="tv" ${isTv ? "selected" : ""}>TV</option>
                    <option value="movie" ${isTv ? "" : "selected"}>Movie</option>
                </select>
                <button class="glass-btn btn-primary" id="search-go">Search</button>
            </div>
            ${imdbRow}
            <div id="search-results" style="margin-top:12px"></div>`;
        modalOverlay.classList.remove("hidden");

        const qEl = $id("search-q"), yEl = $id("search-year"),
              tEl = $id("search-type"), out = $id("search-results"),
              imdbEl = $id("search-imdb");

        const run = async () => {
            const q = qEl.value.trim();
            const imdb = imdbEl ? imdbEl.value.trim() : "";
            if (!q && !imdb) { qEl.focus(); return; }
            out.innerHTML = `<div style="text-align:center;padding:14px;color:var(--txt3)"><span class="spinner"></span></div>`;

            // The endpoint returns nothing for tvmaze+movie / omdb+tv — map
            // those combos to TMDb so the toggle always does what it says.
            const t = tEl.value;
            let ds = elSource.value;
            if (t === "movie" && ds === "tvmaze") ds = "tmdb";
            if (t === "tv" && ds === "omdb") ds = "tmdb";

            let url = `/api/search?q=${encodeURIComponent(q || "x")}&type=${t}&datasource=${ds}`
                    + `&include_adult=${elIncludeAdult.checked}`;
            const y = parseInt(yEl.value, 10);
            if (y) url += `&year=${y}`;
            if (imdb) url += `&imdb_id=${encodeURIComponent(imdb)}`;

            let res;
            try {
                res = await api(url);
            } catch (err) {
                out.innerHTML = `<p class="browse-error">${esc(err.message)}</p>`;
                return;
            }
            const items = res.results || [];
            if (items.length === 0) {
                out.innerHTML = `<p style="text-align:center;padding:14px;color:var(--txt3);font-size:12px">No results — adjust the title or year and try again.</p>`;
                return;
            }
            // Stash candidates so Select handlers don't re-serialize into HTML.
            window._searchCandidates = items;
            let html = `<div class="candidate-list">`;
            items.forEach((c, ci) => {
                const year = c.year ? ` (${c.year})` : "";
                const rating = c.rating ? ` ⭐ ${Number(c.rating).toFixed(1)}` : "";
                const poster = c.poster
                    ? `<img src="${esc(c.poster)}" style="width:40px;height:60px;object-fit:cover;border-radius:4px;">`
                    : `<div style="width:40px;height:60px;background:var(--surface-2);border-radius:4px;"></div>`;
                const overview = c.overview ? `<div style="font-size:10px;color:var(--txt3);margin-top:4px;line-height:1.4">${esc(c.overview)}</div>` : "";
                html += `<div class="candidate-item">
                    ${poster}
                    <div style="flex:1;min-width:0;">
                        <div style="font-weight:500;font-size:12px;color:var(--txt)">${esc(c.title)}${year}${rating}</div>
                        ${overview}
                    </div>
                    <button class="glass-btn btn-primary" style="padding:4px 12px;font-size:11px"
                            onclick="R.pickSearchResult(${idx}, ${ci})">Select</button>
                </div>`;
            });
            html += `</div>`;
            out.innerHTML = html;
        };

        $id("search-go").addEventListener("click", run);
        [qEl, yEl, imdbEl].forEach(el => el && el.addEventListener("keydown", e => {
            e.stopPropagation();   // keep Del/Ctrl+A off the panes behind the modal
            if (e.key === "Enter") { e.preventDefault(); run(); }
        }));
        qEl.focus();
        qEl.select();
    },

    /* Apply a picked search candidate. Series (tv): re-match the file's whole
       clean_name group via the existing selected_show_id flow. Movie: build
       the templated name client-side (no backend movie-id re-match exists)
       and write it into matchResults like an auto-match. */
    async pickSearchResult(idx, ci) {
        const c = (window._searchCandidates || [])[ci];
        const f = scannedFiles[idx];
        if (!c || !f) return;
        delete window._searchCandidates;

        if (c.type === "tv") {
            // Whole detection group — mirrors the backend's grouping key.
            window._pendingMatchFiles = scannedFiles.filter(
                x => x.clean_name === f.clean_name
            );
            await R.selectShow(c.id, c.title);
            return;
        }

        // Movie: format via the same template engine the real rename uses.
        R.closeModal();
        let preview;
        try {
            const data = await api("/api/preview-template", {
                method: "POST",
                body: JSON.stringify({
                    template: elTemplate.value,
                    sample: { ...f, clean_name: c.title, year: c.year, title: c.title },
                }),
            });
            preview = data.preview;
        } catch (err) {
            statusDone("Template failed: " + err.message);
            return;
        }
        const dot = f.filename.lastIndexOf(".");
        const ext = dot > 0 ? f.filename.slice(dot) : "";
        // Sanitize each path segment the way build_new_path() does server-side.
        const parts = preview.split("/").filter(Boolean).map(s =>
            s.replace(/[<>:"\\|?*]/g, "").replace(/[\x00-\x1f]/g, "").replace(/\s+/g, " ").trim()
        ).filter(Boolean);
        if (parts.length === 0) { statusDone("Template produced an empty name"); return; }
        const fileName = parts.pop() + ext;
        const parentDir = f.path.lastIndexOf("/") > 0 ? f.path.slice(0, f.path.lastIndexOf("/")) : ".";
        const newPath = [parentDir, ...parts, fileName].join("/");

        matchResults[idx] = {
            matched: true,
            manual: false,
            score: 1.0,
            original: f.path,
            new_name: fileName,
            new_path: newPath,
            preview: [...parts, fileName].join("/"),
            metadata: { title: c.title, year: c.year, poster: c.poster },
        };
        selectedSet.add(idx);
        renderLeft();
        renderRight();
        renderGutter();
        updateFooter();
        statusDone(`Matched manually: ${c.title}${c.year ? " (" + c.year + ")" : ""}`);
    },

    async selectShow(showId, showName, e) {
        if (e && e.target) {
            e.target.disabled = true;
            e.target.textContent = "Loading...";
        }
        
        modalOverlay.classList.add("hidden");
        status(`Matching against ${showName}…`);

        const filesToMatch = window._pendingMatchFiles || [];
        const ticker = startMatchProgressTicker();
        const gen = sessionGen;

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
            if (gen !== sessionGen) return;   // user hit "start over" meanwhile

            // MERGE results into matchResults (don't rebuild): F7's manual
            // search re-matches only one clean_name group, and a rebuild would
            // wipe every other row's existing match. For the disambiguation
            // flow the whole selection is in flight, so merge ≡ rebuild there.
            if (matchResults.length !== scannedFiles.length) {
                matchResults = new Array(scannedFiles.length).fill(null);
            }
            const resultMap = new Map();
            for (const r of data.results) {
                resultMap.set(r.original, r);
            }
            for (let i = 0; i < scannedFiles.length; i++) {
                const r = resultMap.get(scannedFiles[i].path);
                if (r) matchResults[i] = r;
            }

            applyConfidenceGate();
            renderLeft();   // reflect any rows the gate deselected
            renderRight();
            renderGutter();
            updateFooter();
            const matched = data.results.filter(r => r && r.matched).length;
            statusDone(`Matched ${matched} of ${filesToMatch.length} file(s) with ${showName}`);
        } catch (err) {
            statusDone("Match failed: " + err.message);
        } finally {
            clearInterval(ticker);
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
        // External OS drag over a row: leave it to the document-level
        // handlers (whole window accepts file drops) — don't claim "move".
        // isFileDrag beats a draggedIdx check: it can't go stale.
        if (draggedIdx === null || isFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";

        // Highlight drop target
        if (draggedIdx !== idx) {
            e.currentTarget.classList.add("drag-over");
        }
    },

    drop(e, targetIdx, targetPane) {
        // External OS drag dropped on a row: bubble up to the document
        // handler so the files get scanned — previously this swallowed the
        // drop, making drag&drop "randomly" fail whenever the panes had rows.
        if (draggedIdx === null || isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();

        if (draggedIdx === targetIdx) return;
        
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
        if (!await confirmDialog("Undo this operation? Moves the file back, or removes the created copy/link.", { okText: "Undo" })) return;

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
    
    showAllHistory() {
        showHistory(1000);
    },

    async undoBatch(batchId) {
        if (!await confirmDialog("Undo this entire batch? Files are restored in reverse order.", { okText: "Undo all", danger: true })) return;
        try {
            const r = await api("/api/undo-batch/" + encodeURIComponent(batchId), { method: "POST" });
            status(`Reverted ${r.success} of ${r.total}`);
            setTimeout(() => statusHide(), 2500);
            R.closeModal();
            setTimeout(() => showHistory(), 300);
        } catch (err) {
            status("Batch undo failed: " + err.message);
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
        updateFooter();
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

/* ─── Go to top (appears when the list is scrolled; both panes scroll in sync) ─ */
const btnGoTop = $id("go-top");
const GO_TOP_THRESHOLD = 300;  // px scrolled before the button appears
function updateGoTop() {
    if (!btnGoTop) return;
    const scrolled = Math.max(leftList.scrollTop, rightList.scrollTop);
    btnGoTop.classList.toggle("visible", scrolled > GO_TOP_THRESHOLD);
}
leftList.addEventListener("scroll", updateGoTop);
rightList.addEventListener("scroll", updateGoTop);
btnGoTop?.addEventListener("click", () => {
    // Scrolling the left pane smoothly drags the right pane along via the sync
    // handler above; scroll both explicitly so it works regardless of focus.
    leftList.scrollTo({ top: 0, behavior: "smooth" });
    rightList.scrollTo({ top: 0, behavior: "smooth" });
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
$id("bulk-high")?.addEventListener("click", () => bulkSelect(m => !!(m && m.matched && m.score >= REVIEW_CONFIDENCE)));
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
        R.closeModal();
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
    updateFooter();
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
    updateFooter();
}

/* ─── Modal ───────────────────────────────────────────────── */
modalClose.addEventListener("click", () => R.closeModal());
modalOverlay.addEventListener("click", e => {
    if (e.target === modalOverlay) R.closeModal();
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
