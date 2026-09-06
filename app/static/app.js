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
// Desktop presentation: the OS window frames the app, so sections go
// edge-to-edge (see style.css "Desktop edge-to-edge"). Browser/Docker
// keeps the card look. Same flag, presentation only.
if (isElectron) document.body.classList.add("desktop");
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
        // `pinned` = the user chose this record by id (movie/show
        // disambiguation or Search metadata). Its score stays honest and can
        // be low — name similarity against a deliberately-picked title often
        // is — but the SELECTION reflects a decision, not a guess, so the
        // gate must not silently undo it. Same standing as a manual name.
        if (m && m.matched && !m.manual && !m.pinned && m.score < LOW_CONFIDENCE) {
            selectedSet.delete(i);
        }
    }
}

/* ─── DOM refs ────────────────────────────────────────────── */
const $ = s => document.querySelector(s);
const $id = s => document.getElementById(s);

const elScanPath    = $id("scan-path");
const elRecursive   = $id("recursive");
const elIncludeExtras = $id("include-extras");

/* Scan results carry a `skipped` count (release samples and Extras folders the
   scanner left out). Silence about them would read as files going missing. */
function scanSummary(data) {
    // A cancelled walk returns nothing on purpose — half a folder presented as
    // the whole folder is worse than no answer.
    if (data.cancelled) return "Scan cancelled — nothing was listed";
    const found = `Found ${data.files.length} media file(s)`;
    return data.skipped ? `${found} · ${data.skipped} sample(s)/extra(s) skipped` : found;
}
const elTemplate    = $id("template");
const elSource      = $id("datasource");
const elAction      = $id("action");
const elDest        = $id("dest-path");
const elWriteSidecars = $id("write-sidecars");
const elDestBrowse  = $id("btn-dest-browse");

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
const statHigh         = $id("stat-high");
const statReview       = $id("stat-review");

/* View filter for the dual pane (All / Matched / Unmatched).
   Filters what is VISIBLE only — selection (checkboxes) decides what renames. */
let viewFilter = "all";
/* Text filter (the pane twin of the Browse dialog's "Filter this folder…").
   Same visibility-only contract as viewFilter; composes with it (AND). */
let paneFilterText = "";
function rowHiddenCls(i) {
    if (viewFilter !== "all") {
        const matched = !!(matchResults[i] && matchResults[i].matched);
        if ((viewFilter === "matched") !== matched) return " row-hidden";
    }
    if (paneFilterText) {
        const hay = (scannedFiles[i]?.filename || "") + " " + (matchResults[i]?.new_name || "");
        if (!hay.toLowerCase().includes(paneFilterText)) return " row-hidden";
    }
    return "";
}

/* Action controls: Rename button (label + enabled), Review button, the
   confidence chips, and the bulk-selection buttons — all in the top bar / New
   names header now that the footer is gone. */
function updateFooter() {
    let ready = 0, review = 0;
    for (let i = 0; i < scannedFiles.length; i++) {
        const m = matchResults[i];
        if (m && m.matched) {
            if (selectedSet.has(i)) ready++;
            if (!m.manual && !m.pinned && m.score < REVIEW_CONFIDENCE) review++;
        }
    }
    btnRename.disabled = ready === 0;
    const label = btnRename.querySelector(".btn-label");
    if (label) label.textContent = ready > 0 ? `Rename ${ready} file${ready === 1 ? "" : "s"}` : "Rename";
    if (btnReview) {
        btnReview.classList.toggle("hidden", review === 0);
        btnReview.textContent = `Review ${review} match${review === 1 ? "" : "es"}`;
    }
    if (statHigh && statReview) {
        const high = matchResults.filter(r => r && r.matched && (r.manual || r.pinned || r.score >= REVIEW_CONFIDENCE)).length;
        statHigh.classList.toggle("hidden", high === 0);
        statHigh.textContent = `${high} high`;
        statReview.classList.toggle("hidden", review === 0);
        statReview.textContent = `${review} review`;
    }
    // Bulk-selection buttons only make sense once a match has produced rows to
    // act on — same appear-after-match rule as the high/review chips above.
    const anyResult = matchResults.some(r => r);
    for (const id of ["bulk-matched", "bulk-high", "bulk-clear-unmatched"]) {
        $id(id)?.classList.toggle("hidden", !anyResult);
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
    paneFilterText = "";
    const pf = $id("pane-filter");
    if (pf) pf.value = "";
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
        if (m && m.matched && !m.manual && !m.pinned && m.score < REVIEW_CONFIDENCE) {
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

/* Pane text filter. Debounced ~120 ms: both panes fully re-render on change,
   and typing a word over a 1,000-row batch shouldn't cost one render per
   keystroke (same reasoning as the template preview's debounce). */
let _paneFilterTimer = null;
$id("pane-filter")?.addEventListener("input", e => {
    clearTimeout(_paneFilterTimer);
    _paneFilterTimer = setTimeout(() => {
        paneFilterText = e.target.value.trim().toLowerCase();
        renderLeft();
        renderRight();
    }, 120);
});
// Shield the pane shortcuts: Delete over the panes REMOVES files from the
// batch — keystrokes typed into the filter box must never reach them.
$id("pane-filter")?.addEventListener("keydown", e => {
    if (e.key !== "Escape") e.stopPropagation();   // Esc still closes modals
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
/* Which long-running job the Cancel button would stop, or null when there is
   nothing to stop. A scan and a match are never in flight at once — the UI
   disables the button that starts the other one. */
let cancellableJob = null;
const cancelBtn = $id("status-cancel");

function showCancel(job) {
    cancellableJob = job || null;
    if (!cancelBtn) return;
    cancelBtn.textContent = "Cancel";
    cancelBtn.disabled = false;
    cancelBtn.classList.toggle("hidden", !cancellableJob);
}

function status(msg, pct, job) {
    statusBar.classList.remove("hidden");
    statusText.textContent = msg;
    progressFill.classList.remove("loading");
    if (pct === undefined) {
        progressFill.classList.add("loading");
    } else {
        progressFill.style.width = pct + "%";
    }
    // Only shown when a caller says what pressing it would stop; every other
    // status() call leaves it hidden, so it can never be a dead button.
    showCancel(job);
}
function statusDone(msg) {
    statusText.textContent = msg;
    progressFill.classList.remove("loading");
    progressFill.style.width = "100%";
    showCancel(null);
    setTimeout(() => { statusBar.classList.add("hidden"); }, 2500);
}
function statusHide() { statusBar.classList.add("hidden"); showCancel(null); }

cancelBtn?.addEventListener("click", async () => {
    if (!cancellableJob) return;
    cancelBtn.disabled = true;
    cancelBtn.textContent = "Cancelling…";
    // Cooperative: the backend stops at the next group or directory entry, so
    // the in-flight request returns on its own with whatever it had.
    try { await api(`/api/${cancellableJob}-cancel`, { method: "POST" }); }
    catch { cancelBtn.disabled = false; cancelBtn.textContent = "Cancel"; }
});

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
    let files = Array.from(e.dataTransfer.files || []);

    // Some Chromium builds (notably Linux/Wayland) deliver drops with an empty
    // `files` list while the same File objects sit in `items` — recover them.
    if (files.length === 0 && e.dataTransfer.items) {
        files = Array.from(e.dataTransfer.items)
            .filter(item => item.kind === "file")
            .map(item => item.getAsFile())
            .filter(Boolean);
    }

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
        return;
    }

    // Nothing usable arrived (Wayland drops can deliver before the drag data
    // is readable). Never fail silently — silence reads as "the app is broken".
    statusDone("Couldn't read the dropped files — try again, or use Add Files.");
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
        status("Scanning dropped files…", undefined, "scan");
        const gen = sessionGen;
        try {
            const data = await api("/api/scan-batch", {
                method: "POST",
                body: JSON.stringify({ paths: fullPaths, include_extras: elIncludeExtras.checked }),
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
            statusDone(scanSummary(data));
        } catch (err) {
            statusDone("Scan failed: " + err.message);
        }
    }

    locateGo.addEventListener("click", go);
    locateInput.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
}

function showSelectionDialog(groupName, candidates, filesToMatch, media) {
    const isMovie = media === "movie";
    modalTitle.textContent = "Select best match for \"" + groupName + "\"";

    let html = `<p style="color:var(--txt2);margin-bottom:12px;font-size:12px">Multiple matches found. Select the correct ${isMovie ? "movie" : "show"}:</p>`;
    html += `<div class="candidate-list">`;

    let mi = 0;
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

        // Movie candidates carry STRING ids (OMDb "tt…") — those must never
        // travel through an inline onclick attribute (the results-modal /
        // context-menu rule), so movie Select buttons are index-bound
        // listeners over the candidates array. Series keep the existing
        // numeric-id inline handler unchanged.
        const selectBtn = isMovie
            ? `<button class="glass-btn btn-scan sel-movie" data-mi="${mi++}" style="padding:4px 12px;font-size:11px">Select</button>`
            : `<button class="glass-btn btn-scan" onclick="R.selectShow(${c.id}, '${esc(c.name).replace(/'/g, "\\'")}', event)" style="padding:4px 12px;font-size:11px">Select</button>`;
        html += `<div class="candidate-item" data-id="${c.id}" data-name="${esc(c.name)}">
            ${poster}
            <div style="flex:1;min-width:0;">
                <div style="font-weight:500;font-size:12px;color:var(--txt)">${esc(c.name)}${year}${rating}</div>
                ${chips}
                ${overview}
            </div>
            ${selectBtn}
        </div>`;
    }

    html += `</div>`;
    html += `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:flex;gap:8px">
        <button class="glass-btn" onclick="R.closeModal()" style="flex:1">Cancel</button>
    </div>`;

    modalBody.innerHTML = html;
    if (isMovie) {
        modalBody.querySelectorAll(".sel-movie").forEach(btn => {
            btn.addEventListener("click", e => {
                const c = candidates[Number(btn.dataset.mi)];
                if (c) R.selectMovie(c.id, c.datasource, e);
            });
        });
    }
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

/* Themed multi-field prompt, same shape and keyboard handling as
   confirmDialog. Native prompt() is not an option twice over: this app
   deliberately uses no native dialogs, and ELECTRON DOES NOT IMPLEMENT
   window.prompt at all — a feature built on it would work in Docker and be
   dead on every desktop package.

   `fields` is [{name, label, value, placeholder, hint}]. Resolves to an object
   of trimmed values, or null on cancel. */
function promptDialog(title, fields, { okText = "OK", cancelText = "Cancel" } = {}) {
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
                <div class="prompt-fields"></div>
                <p class="prompt-error" style="color:var(--red);font-size:11px;min-height:14px"></p>
                <div class="confirm-actions">
                    <button class="glass-btn" id="confirm-cancel">${esc(cancelText)}</button>
                    <button class="glass-btn btn-scan" id="confirm-ok">${esc(okText)}</button>
                </div>
            </div>`;
        overlay.querySelector(".confirm-msg").textContent = title;

        const holder = overlay.querySelector(".prompt-fields");
        const inputs = fields.map(field => {
            const wrap = document.createElement("label");
            wrap.className = "prompt-field";
            const label = document.createElement("span");
            label.textContent = field.label;          // textContent — never markup
            const input = document.createElement("input");
            input.className = "glass-input mono";
            input.type = "text";
            input.value = field.value != null ? String(field.value) : "";
            if (field.placeholder) input.placeholder = field.placeholder;
            wrap.append(label, input);
            if (field.hint) {
                const hint = document.createElement("small");
                hint.textContent = field.hint;
                wrap.appendChild(hint);
            }
            holder.appendChild(wrap);
            return [field.name, input];
        });

        overlay.classList.remove("hidden");
        const finish = (value) => {
            overlay.classList.add("hidden");
            document.removeEventListener("keydown", onKey, true);
            resolve(value);
        };
        const submit = () => finish(Object.fromEntries(
            inputs.map(([name, input]) => [name, input.value.trim()])));
        const onKey = (e) => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
            else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); submit(); }
        };
        $id("confirm-ok").addEventListener("click", submit);
        $id("confirm-cancel").addEventListener("click", () => finish(null));
        overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(null); });
        document.addEventListener("keydown", onKey, true);
        inputs[0][1].focus();
        inputs[0][1].select();
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

/* Resolution ranking for the "prefer higher quality" sweep. Deliberately only
   RESOLUTION: a 2160p re-encode can be smaller than a 1080p remux, so size is
   shown to the user but never used to decide for them. */
const QUALITY_RANK = { "480p": 1, "576p": 1, "720p": 2, "1080p": 3, "2160p": 4, "4k": 4 };

function qualityRank(info) {
    const format = (info && info.video_format || "").toLowerCase();
    return QUALITY_RANK[format] || 0;
}

function qualityLabel(info) {
    const parts = [];
    if (info.video_format) parts.push(info.video_format);
    if (info.source) parts.push(info.source);
    if (info.size) parts.push(fmt(info.size));
    return parts.join(" · ") || "unknown";
}

/* A conflict the sweep may act on: an existing file this batch would replace
   with something of strictly higher resolution. Equal or unknown never counts
   — the user can still press Replace on the row itself. */
function isUpgrade(c) {
    return c.type === "file_exists" && c.existing && c.incoming
        && _findIdxByOriginal(c.file) >= 0
        && qualityRank(c.incoming) > qualityRank(c.existing);
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
        // One-click triage for quality doubles: keep the biggest source
        // selected, skip the rest. Only for duplicate_destination with ≥2
        // KNOWN files — "keep largest source" says nothing about a
        // pre-existing destination (file_exists), so those never get it.
        if (isDup && c._origs.filter(o => _findIdxByOriginal(o) >= 0).length >= 2) {
            html += `<button class="glass-btn" style="font-size:10px;padding:3px 8px;margin-top:6px" onclick="R.conflictKeepLargest(${ci})">Keep largest</button>`;
        }
        // file_exists is almost always a quality upgrade, and the app knows
        // both sides. Show them, and offer the answer the user actually wants.
        if (!isDup && c.existing && c.incoming && _findIdxByOriginal(c.file) >= 0) {
            html += `<div style="font-size:10px;color:var(--txt2);margin-top:6px">`;
            html += `existing ${esc(qualityLabel(c.existing))} &nbsp;→&nbsp; incoming ${esc(qualityLabel(c.incoming))}`;
            html += `</div>`;
            html += `<button class="glass-btn" style="font-size:10px;padding:3px 8px;margin-top:6px" onclick="R.conflictReplace(${ci})" title="Rename over the existing file. The old one is moved aside as .replaced-… and Undo restores it — it is never deleted.">Replace (upgrade)</button>`;
        }
        html += `</div>`;
    });

    html += `</div>`;
    html += `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">`;
    const upgradable = _activeConflicts.filter(isUpgrade);
    if (upgradable.length) {
        html += `<label class="cb-label" style="margin-bottom:8px"><input type="checkbox" id="prefer-quality"><span>Prefer higher quality — replace ${upgradable.length} existing file(s) of lower resolution</span></label>`;
    }
    html += `<p style="font-size:10px;color:var(--txt3);margin-bottom:8px">Skip removes the file from the rename selection. Rename → (2) appends " (2)" to the new name. Replace moves the existing file aside as <code>.replaced-…</code> — never deleted, and Undo restores it.</p>`;
    html += `<button class="glass-btn" onclick="R.closeModal()" style="width:100%">Close</button>`;
    html += `</div>`;

    modalBody.innerHTML = html;
    $id("prefer-quality")?.addEventListener("change", e => {
        if (!e.target.checked) return;
        _activeConflicts.filter(isUpgrade).forEach(c => R.conflictReplace(_activeConflicts.indexOf(c)));
    });
    modalOverlay.classList.remove("hidden");
}

async function handleDroppedPaths(paths) {
    // Multiple paths: one /api/scan-batch via the same helper the native
    // picker uses — the backend dedupes overlapping selections by resolved
    // path (a folder + a file inside it = one row) and the "Include
    // subfolders" toggle is honored for dropped folders too (the old
    // per-path loop hardcoded recursive: false). scanPaths owns its own
    // status line and scan-progress ticker.
    if (paths.length > 1) {
        await scanPaths(paths);
        return;
    }

    status("Scanning dropped files…", undefined, "scan");
    const gen = sessionGen;
    const ticker = startScanProgressTicker();

    // A single dropped directory (or file): scan it
    try {
        // Collect into a local first — only committed to scannedFiles after
        // the sessionGen check below, so "start over" can't be overwritten.
        const data = await api("/api/scan", {
            method: "POST",
            body: JSON.stringify({ path: paths[0], recursive: elRecursive.checked, include_extras: elIncludeExtras.checked }),
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
        statusDone(scanSummary(data));
    } catch (err) {
        statusDone("Drop failed: " + err.message);
    } finally {
        clearInterval(ticker);
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

/* ─── Action → Destination availability ───────────────────────
   Rename (in-place) never moves files, so the Destination field + Browse
   can't apply — disable them. (The old per-action explanation line was
   removed; the action labels are self-explanatory.) */
function updateActionUI() {
    if (!elDest) return;
    const inPlace = elAction.value === "rename";
    elDest.disabled = inPlace;
    if (elDestBrowse) elDestBrowse.disabled = inPlace;
    elDest.title = inPlace
        ? "Rename (in-place) never moves files — destination not used"
        : "Optional: build template paths under this folder instead of next to each file";
}

elAction.addEventListener("change", () => {
    updateActionUI();
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

/* Preferences live in two places on purpose.
   localStorage is the SYNCHRONOUS mirror: it restores instantly at startup, so
   the options card never flashes defaults while a fetch is in flight, and it
   still works when the backend is unreachable.
   The server copy is what makes one instance behave like one app — the Docker
   image is the recommended NAS deployment, so "the app" is one backend with a
   desktop browser, a laptop and a phone in front of it.
   What stays local-only: the theme and the last-scanned path. Those describe
   the device you are sitting at, not how you organize your library. */
const SHARED_PREFS_DEBOUNCE_MS = 500;
let sharedPrefsTimer = null;

function sharedPrefsPayload() {
    return {
        datasource: elSource.value,
        action: elAction.value,
        template: elTemplate.value,
        destination: elDest ? elDest.value : "",
        subfolders: !!(elRecursive && elRecursive.checked),
        include_extras: !!(elIncludeExtras && elIncludeExtras.checked),
        write_sidecars: !!(elWriteSidecars && elWriteSidecars.checked),
    };
}

function pushSharedPrefs(extra) {
    // Fire-and-forget and debounced: typing in the template field must not
    // issue a request per keystroke, and a failed sync is never worth an error
    // in front of the user — localStorage already holds the value.
    clearTimeout(sharedPrefsTimer);
    sharedPrefsTimer = setTimeout(() => {
        api("/api/prefs", { method: "PUT", body: JSON.stringify({ ...sharedPrefsPayload(), ...extra }) })
            .catch(() => {});
    }, SHARED_PREFS_DEBOUNCE_MS);
}

function persistPrefsLocal() {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({
            datasource: elSource.value,
            action: elAction.value,
            template: elTemplate.value,
            scanPath: elScanPath.value,
            destPath: elDest ? elDest.value : "",
            subfolders: !!(elRecursive && elRecursive.checked),
            includeExtras: !!(elIncludeExtras && elIncludeExtras.checked),
            writeSidecars: !!(elWriteSidecars && elWriteSidecars.checked),
            theme: currentTheme(),
        }));
    } catch { /* storage disabled — non-fatal */ }
}

function persistPrefs() {
    persistPrefsLocal();
    pushSharedPrefs();
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
    if (elDest && typeof p.destPath === "string" && p.destPath) elDest.value = p.destPath;
    if (elRecursive && typeof p.subfolders === "boolean") elRecursive.checked = p.subfolders;
    if (elIncludeExtras) elIncludeExtras.checked = p.includeExtras === true;
    if (elWriteSidecars) elWriteSidecars.checked = p.writeSidecars === true;
    applyTheme(p.theme || "dark");
}

/* Second pass: adopt whatever this INSTANCE knows, so a fresh browser inherits
   the options and presets the user built elsewhere. Runs after the synchronous
   restore above, and silently does nothing when the backend is unreachable. */
async function syncPrefsFromServer() {
    let shared;
    try { shared = await api("/api/prefs"); }
    catch { return; }
    if (!shared || typeof shared !== "object") return;

    if (shared.datasource && [...elSource.options].some(o => o.value === shared.datasource)) elSource.value = shared.datasource;
    if (shared.action && [...elAction.options].some(o => o.value === shared.action)) elAction.value = shared.action;
    if (typeof shared.template === "string" && shared.template) elTemplate.value = shared.template;
    if (elDest && typeof shared.destination === "string" && shared.destination) elDest.value = shared.destination;
    if (elRecursive && typeof shared.subfolders === "boolean") elRecursive.checked = shared.subfolders;
    if (elIncludeExtras && typeof shared.include_extras === "boolean") elIncludeExtras.checked = shared.include_extras;
    if (elWriteSidecars && typeof shared.write_sidecars === "boolean") elWriteSidecars.checked = shared.write_sidecars;

    if (Array.isArray(shared.custom_presets)) {
        saveCustomPresets(shared.custom_presets, { push: false });
        renderCustomPresets();
    }
    updateActionUI();
    updateTemplatePreview();
    // Mirror what the server just told us, WITHOUT echoing it back. Skipping
    // this left localStorage holding the startup defaults, so the next load
    // with an unreachable backend would silently drop the shared template.
    persistPrefsLocal();
}
restorePrefs();

updateActionUI(); // run once on load (after prefs restore so it reflects the saved action)

// Then adopt this instance's shared preferences, if it has any. Deliberately
// not awaited: the UI is already usable from localStorage, and a slow or
// absent backend must not delay it.
syncPrefsFromServer();

/* ─── Custom template presets ─────────────────────────────────
   Saved under their own localStorage key (same per-origin persistence as
   PREFS_KEY — identical in the Electron renderer and any browser). Labels
   and templates are USER-CONTROLLED strings: buttons are built with
   createElement + textContent + index closures, never innerHTML — esc()
   doesn't escape quotes in attribute context, so string-built markup would
   be injectable here. */
const CUSTOM_PRESETS_KEY = "cinesort.customPresets";
const CUSTOM_PRESETS_MAX = 12;

function loadCustomPresets() {
    try {
        const raw = JSON.parse(localStorage.getItem(CUSTOM_PRESETS_KEY) || "[]");
        if (!Array.isArray(raw)) return [];
        return raw
            .filter(p => p && typeof p.label === "string" && typeof p.template === "string"
                          && p.label.trim() && p.template.trim()
                          && p.label.length <= 24 && p.template.length <= 500)
            .slice(0, CUSTOM_PRESETS_MAX);
    } catch { return []; }   // malformed storage degrades to no custom presets
}
function saveCustomPresets(list, { push = true } = {}) {
    try { localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(list)); }
    catch { /* storage disabled — non-fatal, presets just don't persist */ }
    // push:false when the list CAME from the server — echoing it straight back
    // would be a pointless round trip.
    if (push) pushSharedPrefs({ custom_presets: list });
}

function renderCustomPresets() {
    const slot = $id("custom-presets");
    if (!slot) return;
    slot.textContent = "";
    const presets = loadCustomPresets();
    presets.forEach((p, i) => {
        const btn = document.createElement("button");
        btn.className = "preset-btn preset-custom";
        btn.textContent = p.label;
        btn.title = p.template + "  ·  right-click to remove";
        btn.addEventListener("click", () => {
            elTemplate.value = p.template;
            persistPrefs();
            updateTemplatePreview();
        });
        btn.addEventListener("contextmenu", async e => {
            e.preventDefault();
            if (!await confirmDialog(`Remove preset "${p.label}"?`, { okText: "Remove", danger: true })) return;
            const list = loadCustomPresets();
            list.splice(i, 1);
            saveCustomPresets(list);
            renderCustomPresets();
            status(`Preset removed: ${p.label}`);
            setTimeout(() => statusHide(), 1500);
        });
        slot.appendChild(btn);
    });
    // A saved preset may match the current template — reflect its active state.
    if (typeof highlightActivePreset === "function") highlightActivePreset();
}

$id("template-save")?.addEventListener("click", () => {
    const tpl = elTemplate.value.trim();
    if (!tpl) { elTemplate.focus(); return; }
    const list = loadCustomPresets();
    if (list.length >= CUSTOM_PRESETS_MAX) {
        status(`Preset limit reached (${CUSTOM_PRESETS_MAX}) — right-click one to remove it first`);
        setTimeout(() => statusHide(), 2500);
        return;
    }
    modalTitle.textContent = "Save preset";
    modalBody.innerHTML = `
        <p style="color:var(--txt2);font-size:12px;margin-bottom:8px">
            Name for this template preset:</p>
        <code style="display:block;font-size:11px;color:var(--txt3);margin-bottom:10px;word-break:break-all" id="save-preset-tpl"></code>
        <div style="display:flex;gap:8px">
            <input type="text" id="preset-name" class="glass-input" style="flex:1" maxlength="24" spellcheck="false">
            <button class="glass-btn btn-scan" id="preset-name-ok">Save preset</button>
        </div>
        <p style="font-size:10px;color:var(--txt3);margin-top:8px">Saving under an existing name replaces it. Right-click a saved preset to remove it.</p>`;
    // textContent, not markup — the template is user input.
    $id("save-preset-tpl").textContent = tpl;
    const nameEl = $id("preset-name");
    nameEl.value = tpl.slice(0, 18);
    modalOverlay.classList.remove("hidden");
    nameEl.focus();
    nameEl.select();

    const commit = () => {
        const label = nameEl.value.trim().slice(0, 24);
        if (!label) { nameEl.focus(); return; }
        const fresh = loadCustomPresets().filter(p => p.label !== label);
        fresh.push({ label, template: tpl });
        saveCustomPresets(fresh);
        renderCustomPresets();
        R.closeModal();
        status(`Preset saved: ${label}`);
        setTimeout(() => statusHide(), 1500);
    };
    $id("preset-name-ok").addEventListener("click", commit);
    nameEl.addEventListener("keydown", e => {
        e.stopPropagation();   // shield the pane shortcuts, as every modal input does
        if (e.key === "Enter") { e.preventDefault(); commit(); }
    });
});

renderCustomPresets();   // initial render from storage

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
    }
    if ([...elAction.options].some(o => o.value === saved)) elAction.value = saved;
    updateActionUI();
})();


elScanPath.addEventListener("keydown", e => { if (e.key === "Enter") doScan(); });
elDest?.addEventListener("input", persistPrefs);

/* ─── Destination browse ──────────────────────────────────────
   Same thin adapter as the scan Browse button: native OS folder picker on
   desktop (reaches $HOME/mounts, can create a new folder), the allow-listed
   HTML browser (mounted volumes only) on Docker/web. Both write the chosen
   folder into #dest-path. */
function setDestination(dir) {
    if (!elDest || !dir) return;
    elDest.value = dir;
    persistPrefs();
    status(`Destination: ${dir}`);
    setTimeout(() => statusHide(), 1800);
}
async function pickDestFolder() {
    let paths = [];
    try {
        paths = await window.electronAPI.pickPaths({
            properties: ["openDirectory", "createDirectory", "showHiddenFiles"],
        });
    } catch (err) {
        statusDone("Picker failed: " + err.message);
        return;
    }
    if (paths && paths[0]) setDestination(paths[0]);   // single folder (no multiSelections)
}
elDestBrowse?.addEventListener("click", () => {
    if (elDestBrowse.disabled) return;
    if (isElectron && typeof window.electronAPI.pickPaths === "function") {
        pickDestFolder();
    } else {
        // Start where the field already points (if valid), else the default root.
        showBrowseDialog(elDest?.value.trim() || undefined,
                         { mode: "pickFolder", onPick: setDestination });
    }
});
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
    status(`Scanning ${paths.length} item(s)…`, undefined, "scan");
    const gen = sessionGen;
    const ticker = startScanProgressTicker();
    try {
        const data = await api("/api/scan-batch", {
            method: "POST",
            // Honor the "Include subfolders" toggle for folder selections too.
            body: JSON.stringify({ paths, recursive: elRecursive.checked, include_extras: elIncludeExtras.checked }),
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
        statusDone(scanSummary(data));
    } catch (err) {
        statusDone("Scan failed: " + err.message);
    } finally {
        clearInterval(ticker);
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

async function showBrowseDialog(startPath, opts = {}) {
    // mode "scan" (default): multi-select files/folders → scanPaths.
    // mode "pickFolder": navigate to ONE folder and commit it via opts.onPick
    // (the Destination browse). Same allow-listed /api/browse either way.
    const pickFolder = opts.mode === "pickFolder";
    modalTitle.textContent = pickFolder ? "Choose Destination Folder" : "Browse Folders";
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
        main += `<div id="browser-list" tabindex="0" class="browse-list" role="listbox" aria-multiselectable="${!pickFolder}" aria-label="Folder contents"></div>`;
        if (pickFolder) {
            main += `<div class="browse-tray" id="browse-tray"></div>`;
            main += `<div class="browse-actions">
                <button class="glass-btn" id="browse-cancel">Cancel</button>
                <button class="glass-btn btn-scan" id="browse-use">Use this folder</button>
            </div>`;
        } else {
            main += `<div class="browse-tray" id="browse-tray"></div>`;
            main += `<div class="browse-actions">
                <button class="glass-btn" id="browse-select-visible">Select Visible</button>
                <button class="glass-btn" id="browse-cancel">Cancel</button>
                <button class="glass-btn btn-scan" id="browse-scan">Scan</button>
            </div>`;
        }
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

        $id("browse-select-visible")?.addEventListener("click", () => {
            for (const item of visibleItems()) {
                if (item.type !== "parent") selectedPaths.add(item.path);
            }
            renderList();
        });
        $id("browse-cancel").addEventListener("click", () => R.closeModal());
        $id("browse-scan")?.addEventListener("click", doScanSelection);
        $id("browse-use")?.addEventListener("click", commitFolderPick);

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
                    else if (pickFolder) commitFolderPick();   // files aren't the target — use the folder we're in
                    else doScanSelection();
                } else if (e.key === " " && !pickFolder) {
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
                // pickFolder mode: no checkboxes — you navigate to a folder and
                // commit it; files play no part in choosing a destination.
                const checkbox = (isParent || pickFolder) ? "" : `<input type="checkbox" ${checked} data-idx="${i}" aria-label="Select ${esc(item.name)}">`;
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
                if (pickFolder) return;   // files don't select in destination mode
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
        if (pickFolder) {
            if (tray) tray.innerHTML =
                `<span class="browse-tray-empty">Files here won't be touched — "Use this folder" sets it as the destination.</span>`;
            const useBtn = $id("browse-use");
            if (useBtn) useBtn.textContent = `Use “${Path.basename(currentPath) || currentPath}”`;
            return;
        }
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

    function commitFolderPick() {
        const dir = currentPath;
        R.closeModal();
        if (typeof opts.onPick === "function" && dir) opts.onPick(dir);
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

    status("Scanning…", undefined, "scan");
    btnScan.disabled = true;
    const gen = sessionGen;
    const ticker = startScanProgressTicker();

    try {
        const data = await api("/api/scan", {
            method: "POST",
            body: JSON.stringify({ path, recursive: elRecursive.checked, include_extras: elIncludeExtras.checked }),
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
        statusDone(scanSummary(data));
    } catch (err) {
        statusDone("Scan failed: " + err.message);
    } finally {
        clearInterval(ticker);
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

/* Scan twin of the two tickers above — totals are unknowable up front, so
   the bar stays indeterminate and the text counts upward:
   "Scanning… 1,240 items · 312 media files". */
function startScanProgressTicker() {
    return setInterval(async () => {
        try {
            const p = await api("/api/scan-progress");
            if (p.active) {
                statusText.textContent =
                    `Scanning… ${p.seen.toLocaleString()} items · ${p.media.toLocaleString()} media files`;
                progressFill.classList.add("loading");
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
    status(`Matching ${filesToMatch.length} file(s) against ${src}…`, undefined, "match");
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
                    output_dir: elDest?.value.trim() || null,
            }),
        });
        if (gen !== sessionGen) return;   // user hit "start over" meanwhile
        clearInterval(ticker);

        // Check if we need user to select from multiple shows
        if (data.needs_selection) {
            statusHide();
            showSelectionDialog(data.group_name, data.candidates, filesToMatch, data.media);
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
        const cancelledRows = (data.results || [])
            .filter(r => r && r.reason === "Cancelled before matching").length;
        if (cancelledRows) suffix.push(`cancelled — ${cancelledRows} file(s) not looked up`);
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
        ops.push({
            original: m.original, new_path: m.new_path,
            // Only read server-side when write_sidecars is on; harmless otherwise.
            metadata: m.metadata, is_subtitle: !!m.is_subtitle,
            // Recorded in history so the log can say WHY this file was renamed,
            // and be re-applied later without asking a provider again.
            confidence: m.score, datasource: m.metadata && m.metadata.datasource,
            template: elTemplate.value,
            // Set by the conflicts dialog: rename over the existing file,
            // parking it rather than deleting it.
            replace_existing: !!m.replace_existing,
        });
    }
    if (ops.length === 0) return;

    const action = elAction.value;
    status(`Renaming ${ops.length} file(s) (${action})…`);
    btnRename.disabled = true;
    const ticker = startRenameProgressTicker();

    try {
        const data = await api("/api/rename", {
            method: "POST",
            body: JSON.stringify({
                operations: ops, action,
                write_sidecars: !!(elWriteSidecars && elWriteSidecars.checked),
            }),
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
            updateTemplatePreview();   // panes cleared — drop the sampled filename
        }
    } catch (err) {
        statusDone("Rename failed: " + err.message);
    } finally {
        clearInterval(ticker);
        // Recompute the button from current state rather than forcing it
        // enabled: after a successful rename the panes are cleared, so Rename
        // must go back to disabled/"Rename"; after a failure the selection is
        // intact, so it re-enables with its count. (The old unconditional
        // re-enable left a stale "Rename N files" on empty panes.)
        updateFooter();
    }
}

function showRenameResults(data) {
    modalTitle.textContent = `Rename Results — ${data.action}`;
    let html = `<p style="margin-bottom:10px;color:var(--txt2)">
        ${data.success} succeeded, ${data.failed} failed of ${data.total}</p>`;
    // Undo at the point of regret: revert the whole batch right from the
    // results. Only when something actually changed on disk — dry runs and
    // all-failed batches get no button. R.undoBatch owns the confirm dialog,
    // the API call, and the History follow-up.
    if (data.batch_id && data.success > 0 && data.action !== "test") {
        html += `<button class="glass-btn" id="res-undo-all"
                style="margin-bottom:10px;padding:4px 12px;font-size:11px">Undo all (${data.success})</button>`;
    }
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
    // Sidecars are best-effort by design (a failed poster fetch must never
    // mark a moved file as failed), so their failures get their own block
    // instead of being folded into the per-file rows.
    if (data.sidecar_errors && data.sidecar_errors.length) {
        html += `<p style="margin-top:12px;color:var(--txt2)">Sidecar files:
            ${data.sidecar_errors.length} could not be written</p>`;
        data.sidecar_errors.forEach(e => { html += `<div class="res-err">${esc(e)}</div>`; });
    }
    modalBody.innerHTML = html;
    $id("res-undo-all")?.addEventListener("click", () => R.undoBatch(data.batch_id));
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
let updCheckMsg = "";     // manual check outcome (up-to-date / failed / disabled)
let updCheckWarn = false; // amber styling for failure/disabled outcomes

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

    // Up to date — the quiet default. "Check for updates" bypasses the
    // daily window (the backend keeps a 30 s floor and the deployment
    // kill-switch always wins); the outcome is reported honestly below.
    if (!upd || !upd.latest) {
        slot.innerHTML = `
            <div class="update-card">
                <div class="update-row">
                    <span class="update-chip ok">✓ Up to date</span>
                    <span style="font-weight:650">CineSort v${esc(v.version)}</span>
                    <span class="up-tiny" style="flex:1">automatic check once per day</span>
                    <button class="glass-btn" id="btn-upd-check" style="flex-shrink:0">Check for updates</button>
                    <a class="up-tiny" href="${esc(relUrl)}" target="_blank" rel="noopener noreferrer">Releases on GitHub</a>
                </div>
                ${updCheckMsg ? `<div class="up-tiny" style="margin-top:6px${updCheckWarn ? ";color:var(--amber)" : ""}">${esc(updCheckMsg)}</div>` : ""}
            </div>`;
        $id("btn-upd-check")?.addEventListener("click", updCheckNow);
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

/* Manual update check (Settings card). force=1 bypasses the 24 h cache;
   the three outcomes get honest copy — a person who clicked deserves the
   truth, not a silent "no update" that might be a network failure. */
async function updCheckNow() {
    const btn = $id("btn-upd-check");
    if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
    updCheckMsg = ""; updCheckWarn = false;
    try {
        const v = await api("/api/version?force=1");
        updInfo = v;
        if (v.check_disabled) {
            updCheckMsg = "Update checks are disabled on this deployment (CINESORT_UPDATE_CHECK=0).";
            updCheckWarn = true;
        } else if (v.check_failed) {
            updCheckMsg = "Couldn't reach GitHub — check your connection and try again.";
            updCheckWarn = true;
        } else if (!(v.update && v.update.latest)) {
            updCheckMsg = "Checked just now — you're on the latest version.";
        }
        // An update found needs no note: the card re-renders into the
        // "new version available" state right below this line.
    } catch (err) {
        updCheckMsg = "Check failed: " + err.message;
        updCheckWarn = true;
    }
    renderUpdateCard();
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

/* ─── Watch folders card (Settings) ────────────────────────────
   Folders/templates/destinations are USER strings — every element is built
   with createElement + textContent/value, never innerHTML (the F38 rule). */
/* Token reference for the Settings card. Fixed literals (never user data),
   same descriptions the palette tooltips carried — plus the music tokens the
   one-line palette never had room to show. */
/* The token reference comes from GET /api/tokens — the same table
   apply_template validates against, so the palette can never list a token the
   formatter does not know or miss one it does. Fetched once per session. */
let tokenReference = null;

async function loadTokenReference() {
    if (tokenReference) return tokenReference;
    try { tokenReference = await api("/api/tokens"); }
    catch { tokenReference = []; }   // backend unreachable — grid simply empty
    return tokenReference;
}

const TOKEN_GROUPS = [
    ["all", "Every match"],
    ["series", "TV series"],
    ["video", "Video files"],
    ["movie", "Movies"],
    ["music", "Music"],
];

/* An environment variable wins over keys.env on every restart, so a Settings
   edit to such a knob would silently not survive one. Say so rather than
   pretending the field is authoritative. */
function envManagedTuningNote(current) {
    const managed = current.tuning_managed_in_env || {};
    const labels = {
        low_confidence: "weak-match warning", review_confidence: "auto-rename threshold",
        watch_interval: "watch interval", cache_ttl: "metadata cache",
    };
    const names = Object.keys(labels).filter(k => managed[k]).map(k => labels[k]);
    if (!names.length) return "";
    return `<p class="settings-hint" style="color:var(--amber,#d98e00)">
        Set in this deployment's environment: ${esc(names.join(", "))}.
        Changes here are saved but the environment value wins on restart.</p>`;
}

/* Token palette, grouped by where each token has a value. Descriptions come
   from the backend, so they are placed with textContent — never markup. */
async function renderTokensGrid() {
    const grid = $id("tokens-grid");
    if (!grid) return;
    const tokens = await loadTokenReference();
    if (!$id("tokens-grid")) return;   // modal changed meanwhile

    grid.textContent = "";
    TOKEN_GROUPS.forEach(([kind, label]) => {
        const inGroup = tokens.filter(t => t.kind === kind);
        if (!inGroup.length) return;
        const heading = document.createElement("div");
        heading.className = "tok-sub";
        heading.textContent = label;
        grid.appendChild(heading);
        inGroup.forEach(t => {
            const item = document.createElement("div");
            item.className = "tok-item";
            const button = document.createElement("button");
            button.className = "token-btn";
            button.dataset.tok = t.name;
            button.textContent = t.name;
            const description = document.createElement("span");
            description.textContent = t.description;
            item.append(button, description);
            grid.appendChild(item);
        });
    });
}

/* Remembered matches (F2). Show/film names are user-influenced strings that
   arrive from providers, so every one is placed with textContent — never
   innerHTML — exactly like the watch card below. */
async function renderAliasesCard() {
    const slot = $id("aliases-card-slot");
    if (!slot) return;
    let data;
    try { data = await api("/api/aliases"); }
    catch { return; }   // backend unreachable — card simply absent
    if (!$id("aliases-card-slot")) return;   // modal changed meanwhile

    const mk = (tag, props = {}, style = "") => {
        const el = document.createElement(tag);
        Object.assign(el, props);
        if (style) el.style.cssText = style;
        return el;
    };

    slot.textContent = "";
    const card = mk("div", { className: "settings-row" });
    card.appendChild(mk("div", { className: "settings-label", textContent: "Remembered matches" }));
    card.appendChild(mk("p", { className: "settings-hint", textContent:
        "Shows and films you picked by hand. Matching uses them automatically, " +
        "so watch folders keep organizing new episodes without asking again." }));

    const aliases = data.aliases || [];
    if (!aliases.length) {
        card.appendChild(mk("p", { className: "settings-hint", textContent:
            "Nothing remembered yet — picks made in the match dialog or Search metadata appear here." }));
        slot.appendChild(card);
        return;
    }

    const rows = mk("div", {}, "display:flex;flex-direction:column;gap:6px");
    aliases.slice().reverse().forEach(a => {
        const row = mk("div", {}, "display:flex;gap:8px;align-items:center;padding:6px 8px;" +
            "background:var(--surface-2);border:1px solid var(--border);border-radius:6px");
        const title = a.year ? `${a.name} (${a.year})` : a.name;
        row.appendChild(mk("span", { textContent: title }, "flex:1;min-width:0;font-size:11px;overflow:hidden;text-overflow:ellipsis"));
        row.appendChild(mk("span", { textContent: `${a.media} · ${a.datasource}` },
            "font-size:10px;color:var(--txt3);flex-shrink:0"));
        const forget = mk("button", { className: "glass-btn", textContent: "Forget" },
            "font-size:10px;padding:3px 8px;flex-shrink:0");
        forget.addEventListener("click", async () => {
            forget.disabled = true;
            try {
                await api(`/api/aliases/${encodeURIComponent(a.key)}`, { method: "DELETE" });
                renderAliasesCard();
            } catch { forget.disabled = false; }
        });
        row.appendChild(forget);
        rows.appendChild(row);
    });
    card.appendChild(rows);
    slot.appendChild(card);
}

async function renderWatchesCard() {
    const slot = $id("watches-card-slot");
    if (!slot) return;
    let data, logData;
    try {
        [data, logData] = await Promise.all([api("/api/watches"), api("/api/watch-log")]);
    } catch { return; }   // backend unreachable — card simply absent
    if (!$id("watches-card-slot")) return;   // modal changed meanwhile

    const watches = data.watches || [];
    const mk = (tag, props = {}, style = "") => {
        const el = document.createElement(tag);
        Object.assign(el, props);
        if (style) el.style.cssText = style;
        return el;
    };
    const shield = el => el.addEventListener("keydown", e => { if (e.key !== "Escape") e.stopPropagation(); });

    slot.textContent = "";
    const card = mk("div", { className: "settings-row" });
    card.appendChild(mk("div", { className: "settings-label", textContent: "Watch folders" }));
    card.appendChild(mk("p", { className: "settings-hint", textContent:
        `Auto-organize: each enabled folder is checked every ${Math.round(data.interval || 60)} s; ` +
        `new files that match confidently are renamed automatically — every run is undoable from History. ` +
        `Ambiguous titles are skipped until you match them once manually. Watches run while CineSort is open.` }));

    const rows = mk("div", {}, "display:flex;flex-direction:column;gap:8px");
    const sources = [["tmdb", "TMDb"], ["tvmaze", "TVmaze"], ["omdb", "OMDb"], ["musicbrainz", "MusicBrainz"]];
    const actions = [["move", "Move"], ["copy", "Copy"], ["reflink", "Reflink copy"], ["hardlink", "Hard Link"], ["symlink", "Symlink"], ["keeplink", "Move + Keep Link"]];

    function addRow(w) {
        const row = mk("div", {}, "display:flex;flex-wrap:wrap;gap:6px;align-items:center;" +
            "padding:8px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px");
        const enabled = mk("input", { type: "checkbox", checked: w.enabled !== false, title: "Enabled" });
        const folder = mk("input", { className: "glass-input mono", value: w.folder || "", placeholder: "/path/to/downloads", spellcheck: false }, "flex:2;min-width:160px;font-size:11px");
        const src = mk("select", { className: "glass-select" }, "font-size:11px");
        sources.forEach(([v, l]) => src.appendChild(mk("option", { value: v, textContent: l, selected: v === (w.datasource || "tvmaze") })));
        const tpl = mk("input", { className: "glass-input mono", value: w.template || elTemplate.value, placeholder: "{name}/Season {s}/…", spellcheck: false }, "flex:2;min-width:160px;font-size:11px");
        // Presets by name. The rule still STORES the resolved template string,
        // so watches.py is unchanged and editing a preset later cannot silently
        // repoint a rule that was built from it.
        const preset = mk("select", { className: "glass-select", title: "Fill the template from a preset" }, "font-size:11px;max-width:120px");
        preset.appendChild(mk("option", { value: "", textContent: "Preset…" }));
        // Built-ins are read from the preset buttons themselves, so the two
        // lists cannot drift; custom ones come from the shared prefs.
        const builtins = [...document.querySelectorAll(".template-presets .preset-btn")]
            .map(b => ({ label: b.textContent.trim(), template: b.dataset.template }));
        [...builtins, ...loadCustomPresets()].forEach(entry =>
            preset.appendChild(mk("option", { value: entry.template, textContent: entry.label })));
        preset.addEventListener("change", () => {
            if (preset.value) tpl.value = preset.value;
            preset.value = "";
        });
        const act = mk("select", { className: "glass-select" }, "font-size:11px");
        actions.forEach(([v, l]) => act.appendChild(mk("option", { value: v, textContent: l, selected: v === (w.action || "move") })));
        const dest = mk("input", { className: "glass-input mono", value: w.output_dir || "", placeholder: "Destination (optional)", spellcheck: false }, "flex:2;min-width:160px;font-size:11px");
        const nfo = mk("input", { type: "checkbox", checked: w.write_sidecars === true,
            title: "Write .nfo + poster for files this rule organizes" });
        const nfoLabel = mk("label", {}, "display:flex;align-items:center;gap:3px;font-size:10px;color:var(--txt2)");
        nfoLabel.append(nfo, mk("span", { textContent: ".nfo" }));
        const rm = mk("button", { className: "glass-btn", textContent: "Remove" }, "font-size:10px;padding:3px 8px");
        rm.addEventListener("click", () => row.remove());

        // ── Advanced: what this rule will look at, and how sure it must be.
        // Folded away because the defaults reproduce the old behaviour — a
        // user who never opens it sees no change.
        const check = (label, checked, title) => {
            const box = mk("input", { type: "checkbox", checked, title });
            const wrap = mk("label", { title }, "display:flex;align-items:center;gap:4px;font-size:10px;color:var(--txt2)");
            wrap.append(box, mk("span", { textContent: label }));
            return [box, wrap];
        };
        const [recursive, recursiveLabel] = check("Subfolders", w.recursive !== false,
            "Scan sub-folders of this watched folder");
        const [extras, extrasLabel] = check("Samples & extras", w.include_extras === true,
            "Also organize release samples and Extras/Featurettes folders");
        const typeBoxes = [["series", "TV"], ["movie", "Movies"], ["music", "Music"]].map(([value, label]) => {
            const [box, wrap] = check(label, !w.media_types || w.media_types.includes(value),
                `Organize ${label.toLowerCase()} found in this folder`);
            box.dataset.mediaType = value;
            return [value, box, wrap];
        });
        const minConf = mk("input", {
            className: "glass-input mono", type: "number", min: "0", max: "1", step: "0.05",
            value: w.min_confidence != null ? String(w.min_confidence) : "",
            placeholder: "default",
            title: "Minimum match confidence before this rule renames anything. Blank follows the app-wide review threshold.",
        }, "width:82px;font-size:11px");
        const minConfLabel = mk("label", {}, "display:flex;align-items:center;gap:4px;font-size:10px;color:var(--txt2)");
        minConfLabel.append(mk("span", { textContent: "Min confidence" }), minConf);

        const advanced = mk("details", {}, "flex-basis:100%;margin-top:2px");
        advanced.appendChild(mk("summary", { textContent: "Advanced" },
            "font-size:10px;color:var(--txt3);cursor:pointer"));
        const advRow = mk("div", {}, "display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:6px");
        advRow.append(recursiveLabel, extrasLabel,
            mk("span", { textContent: "Media:" }, "font-size:10px;color:var(--txt3)"),
            ...typeBoxes.map(([, , wrap]) => wrap), minConfLabel);
        advanced.appendChild(advRow);

        [folder, tpl, dest, minConf].forEach(shield);
        row.append(enabled, folder, src, preset, tpl, act, dest, nfoLabel, rm, advanced);
        row._collect = () => {
            const chosen = typeBoxes.filter(([, box]) => box.checked).map(([value]) => value);
            return {
                enabled: enabled.checked, folder: folder.value.trim(),
                datasource: src.value, template: tpl.value.trim(),
                action: act.value, output_dir: dest.value.trim(),
                write_sidecars: nfo.checked,
                recursive: recursive.checked,
                include_extras: extras.checked,
                // All three ticked is the default — send nothing rather than a
                // list, so the rule keeps meaning "every type" if one is added.
                media_types: chosen.length === typeBoxes.length ? null : chosen,
                min_confidence: minConf.value === "" ? null : Number(minConf.value),
            };
        };
        rows.appendChild(row);
    }
    watches.forEach(addRow);
    card.appendChild(rows);

    const btns = mk("div", {}, "display:flex;gap:8px;margin-top:8px;align-items:center");
    const addBtn = mk("button", { className: "glass-btn", textContent: "Add watch" }, "font-size:11px");
    addBtn.addEventListener("click", () => addRow({
        folder: "", datasource: elSource.value === "musicbrainz" ? "tvmaze" : elSource.value,
        template: elTemplate.value, action: "move",
        output_dir: elDest ? elDest.value.trim() : "", enabled: true,
    }));
    const saveBtn = mk("button", { className: "glass-btn btn-scan", textContent: "Save watches" }, "font-size:11px");
    const msg = mk("span", {}, "font-size:11px;min-height:14px");
    saveBtn.addEventListener("click", async () => {
        const list = [...rows.children].map(r => r._collect()).filter(w => w.folder);
        saveBtn.disabled = true;
        try {
            await api("/api/watches", { method: "POST", body: JSON.stringify({ watches: list }) });
            msg.style.color = "var(--green)";
            msg.textContent = "Saved.";
            renderWatchesCard();   // re-render normalized state + fresh log
        } catch (err) {
            msg.style.color = "var(--red)";
            msg.textContent = err.message;
        } finally {
            saveBtn.disabled = false;
        }
    });
    btns.append(addBtn, saveBtn, msg);
    card.appendChild(btns);

    const log = (logData.log || []).slice(-5).reverse();
    if (log.length) {
        const logBox = mk("div", {}, "margin-top:8px;font-size:10px;color:var(--txt3);line-height:1.6");
        logBox.appendChild(mk("div", { textContent: "Recent activity:" }, "font-weight:600"));
        for (const l of log) {
            logBox.appendChild(mk("div", { textContent: `${l.ts}  ${Path.basename(l.folder)} — ${l.message}` }));
        }
        card.appendChild(logBox);
    }
    slot.appendChild(card);
}

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

    // Right-hand affordance in a key's label row: a Remove button when the key
    // is stored in keys.env (UI-owned), a "managed in the environment" note
    // when it's active but came from Docker compose / systemd, nothing when
    // it isn't set. `which` is "tmdb" | "omdb".
    const keyAction = (which, isSet, removable) => {
        if (!isSet) return "";
        if (removable) {
            return `<button class="settings-remove" data-remove-key="${which}" title="Remove this saved key">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-9 0v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6"/></svg>Remove</button>`;
        }
        return `<span class="settings-envnote">set in the environment — manage it there</span>`;
    };

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
                <span>TMDb API key</span>${badge(tmdbSet)}${keyAction("tmdb", tmdbSet, current.tmdb_key_removable)}
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
                <span>OMDb API key</span>${badge(omdbSet)}${keyAction("omdb", omdbSet, current.omdb_key_removable)}
            </div>
            <p class="settings-hint">
                Enables IMDb data + niche-title fallback search. Free: 1,000 req/day.
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

        <div class="settings-row">
            <div class="settings-label"><span>Matching &amp; performance</span></div>
            <p class="settings-hint">
                How sure CineSort must be before it acts, and how often it looks.
                These applied only through environment variables before, which a
                desktop launcher cannot pass — so they were Docker-only.
            </p>
            <div class="tuning-grid">
                <label>Weak-match warning
                    <input type="number" id="set-low-conf" class="glass-input mono"
                           min="0" max="1" step="0.05" value="${esc(String(current.low_confidence ?? 0.4))}"
                           title="Rows scoring below this are flagged as weak in the review list">
                </label>
                <label>Auto-rename threshold
                    <input type="number" id="set-review-conf" class="glass-input mono"
                           min="0" max="1" step="0.05" value="${esc(String(current.review_confidence ?? 0.6))}"
                           title="Watch folders never rename below this score. Must be above the weak-match warning.">
                </label>
                <label>Watch interval (s)
                    <input type="number" id="set-watch-interval" class="glass-input mono"
                           min="10" step="10" value="${esc(String(Math.round(current.watch_interval ?? 60)))}"
                           title="Seconds between watch-folder checks">
                </label>
                <label>Metadata cache (s)
                    <input type="number" id="set-cache-ttl" class="glass-input mono"
                           min="0" step="60" value="${esc(String(Math.round(current.cache_ttl ?? 900)))}"
                           title="How long provider responses are reused. 0 disables caching.">
                </label>
            </div>
            ${envManagedTuningNote(current)}
            ${isElectron ? `
            <label class="cb-label" style="margin-top:10px" title="Closing the window minimizes CineSort to the tray so watch folders keep organizing in the background">
                <input type="checkbox" id="set-keep-tray" ${current.keep_in_tray ? "checked" : ""}>
                <span>Keep running in the tray when the window is closed</span>
            </label>` : ""}
        </div>

        <div class="settings-row" id="tokens-card">
            <div class="settings-label"><span>Template tokens</span></div>
            <p class="settings-hint">
                Click a token to copy it, then paste it into the naming template.
                Empty tokens collapse cleanly — brackets around them disappear
                when there is no value.
            </p>
            <div class="tokens-grid" id="tokens-grid"></div>
            <div class="tokens-copied" id="tokens-copied"></div>
        </div>

        <div id="watches-card-slot"></div>

        <div id="aliases-card-slot"></div>

        <div id="update-card-slot"></div>

        <div style="display:flex;gap:8px;margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
            <button class="glass-btn" onclick="R.closeModal()" style="flex:1">Cancel</button>
            <button class="glass-btn btn-scan" id="settings-save" style="flex:2">Save &amp; Apply</button>
        </div>
        <p id="settings-msg" style="font-size:11px;margin-top:10px;min-height:16px"></p>
        <p id="settings-version" style="font-size:11px;margin-top:4px;color:var(--txt3)"></p>`;

    renderTokensGrid();

    // Watch-folders card (best-effort, like the update card below).
    renderWatchesCard();
    renderAliasesCard();

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

    // Remove a saved key: confirm → POST the explicit clear flag → re-render
    // Settings so the badge/affordance update. Blank fields never clear a key;
    // only this does.
    modalBody.querySelectorAll(".settings-remove").forEach(btn => {
        btn.addEventListener("click", async () => {
            const which = btn.dataset.removeKey;   // "tmdb" | "omdb"
            const name = which === "tmdb" ? "TMDb" : "OMDb";
            const consequence = which === "tmdb"
                ? "TV + movie metadata lookup will be disabled until you add a new one."
                : "IMDb fallback search will be disabled until you add a new one.";
            if (!await confirmDialog(`Remove your ${name} key? ${consequence}`,
                                     { okText: "Remove key", danger: true })) return;
            try {
                const body = which === "tmdb" ? { clear_tmdb: true } : { clear_omdb: true };
                const result = await api("/api/settings", { method: "POST", body: JSON.stringify(body) });
                // The TMDb key gates the first-run banner — resurface it if the
                // key that was just removed leaves no TMDb source.
                if (which === "tmdb" && !result.tmdb_enabled) keyBanner.classList.remove("hidden");
                status(`${name} key removed`);
                setTimeout(() => statusHide(), 1500);
                showSettings();   // re-render: badge → Not set, Remove gone
            } catch (err) {
                status(`Couldn't remove the ${name} key: ${err.message}`);
                setTimeout(() => statusHide(), 2500);
            }
        });
    });

    // Template tokens: click-to-copy with inline confirmation (the main
    // status bar sits behind the modal, so feedback lives in the card).
    $id("tokens-card")?.addEventListener("click", e => {
        const btn = e.target.closest(".token-btn[data-tok]");
        if (!btn) return;
        const tok = btn.dataset.tok;
        navigator.clipboard.writeText(tok).then(() => {
            const msg = $id("tokens-copied");
            if (msg) msg.textContent = `Copied ${tok} — paste it into the naming template.`;
        }).catch(() => { /* clipboard unavailable — selection still possible */ });
    });
    if (scrollTo === "tokens") {
        $id("tokens-card")?.scrollIntoView({ block: "center" });
    }

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
            // A blank tuning field means "leave it alone" — the backend treats
            // null as untouched, so an empty box can never reset a threshold.
            const num = id => {
                const el = $id(id);
                return el && el.value !== "" ? Number(el.value) : null;
            };
            const result = await api("/api/settings", {
                method: "POST",
                body: JSON.stringify({
                    tmdb_key: tmdbVal, omdb_key: omdbVal, tmdb_language: langVal,
                    low_confidence: num("set-low-conf"),
                    review_confidence: num("set-review-conf"),
                    watch_interval: num("set-watch-interval"),
                    cache_ttl: num("set-cache-ttl"),
                    // Desktop only — the control does not exist elsewhere, and
                    // null means "leave it alone".
                    keep_in_tray: $id("set-keep-tray") ? $id("set-keep-tray").checked : null,
                }),
            });
            // Apply to the running shell too, so the tray appears or goes away
            // without a restart.
            if (isElectron && typeof window.electronAPI.setTray === "function"
                    && $id("set-keep-tray")) {
                window.electronAPI.setTray($id("set-keep-tray").checked);
            }
            msg.style.color = "var(--green)";
            msg.textContent = "✓ Saved. Settings are active for this session.";
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

/* "Breaking Bad · S01E01 · tmdb 1396 · 0.97" — the reasoning behind a rename,
   which the log used to lose the moment the dialog closed. */
function historySummary(entry) {
    const meta = entry.metadata;
    if (!meta) return "";
    const parts = [];
    const title = meta.show || meta.title;
    if (title) parts.push(title);
    if (meta.season != null && meta.episode != null) {
        parts.push(`S${String(meta.season).padStart(2, "0")}E${String(meta.episode).padStart(2, "0")}`);
    } else if (meta.show_year || meta.year) {
        parts.push(String(meta.show_year || meta.year));
    }
    const source = entry.datasource || meta.datasource;
    const id = meta.tmdbid || meta.imdbid;
    if (source) parts.push(id ? `${source} ${id}` : source);
    if (entry.confidence != null) parts.push(Number(entry.confidence).toFixed(2));
    return parts.join(" · ");
}

/* Re-render one past rename under the CURRENT template. The new path is
   computed server-side from stored metadata — no provider call — and then goes
   through the ordinary /api/rename, so history and undo stay the one path that
   touches files. */
/* A plain download in a browser. The Electron renderer has no download UI, so
   the desktop build hands the URL to the OS browser instead — the same
   split the update card already makes. */
function exportHistoryCsv() {
    const url = new URL("/api/history/export.csv", location.origin).href;
    if (isElectron && typeof window.electronAPI.openExternal === "function") {
        window.electronAPI.openExternal(url);
        return;
    }
    const link = document.createElement("a");
    link.href = url;
    link.download = "cinesort-history.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
}

async function reapplyHistoryEntry(entry) {
    let plan;
    try {
        plan = await api("/api/history/reapply", {
            method: "POST",
            body: JSON.stringify({ id: entry.id, template: elTemplate.value,
                                   output_dir: elDest?.value.trim() || null }),
        });
    } catch (err) {
        status("Re-apply failed: " + err.message);
        setTimeout(() => statusHide(), 3000);
        return;
    }
    if (plan.unchanged) {
        status("Already named that way under the current template");
        setTimeout(() => statusHide(), 2500);
        return;
    }
    const ok = await confirmDialog(
        `Rename to "${plan.new_name}"?`, { okText: "Rename" });
    if (!ok) return;
    try {
        await api("/api/rename", {
            method: "POST",
            body: JSON.stringify({
                operations: [{ original: plan.original, new_path: plan.new_path,
                               metadata: entry.metadata, template: elTemplate.value,
                               confidence: entry.confidence, datasource: entry.datasource }],
                action: "move",
            }),
        });
        showHistory();
    } catch (err) {
        status("Rename failed: " + err.message);
        setTimeout(() => statusHide(), 3000);
    }
}

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

        // Entries in RENDER order — .hist-act buttons carry data-h indices
        // into this array so paths/errors never travel through onclick
        // attributes (the F11 results-modal pattern; esc() doesn't escape
        // quotes, so attribute-quoted paths break on apostrophes).
        const flat = [];
        const rowHtml = (e) => {
            const hIdx = flat.push(e) - 1;
            const time = new Date(e.timestamp).toLocaleString();
            const actionColor = e.action === "move" ? "var(--green)" : e.action === "copy" ? "var(--info)" : "var(--amber)";
            const statusIcon = e.success ? "✓" : "✗";
            const statusColor = e.success ? "var(--green)" : "var(--red)";
            // Basenames keep rows scannable; the tooltip carries the full paths.
            let h = `<div style="padding:10px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px" title="${esc(e.original)} → ${esc(e.destination)}">`;
            h += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">`;
            h += `<div style="display:flex;gap:8px;align-items:center">`;
            h += `<span style="color:${statusColor};font-weight:600">${statusIcon}</span>`;
            h += `<span style="color:${actionColor};font-weight:500;font-size:11px;text-transform:uppercase">${e.action}</span>`;
            h += `<span style="color:var(--txt3);font-size:10px">${time}</span>`;
            h += `</div>`;
            h += `<div style="display:flex;gap:6px;align-items:center">`;
            // Per-row action mirroring the Rename Results modal: reveal/copy the
            // destination (for undo entries that's where the file went BACK to),
            // or copy the error. Test rows changed nothing on disk — no button.
            const actLabel = e.success
                ? (e.action === "test" ? "" : (canShowInFolder ? "Show in folder" : "Copy path"))
                : "Copy error";
            if (actLabel) {
                h += `<button class="glass-btn hist-act" data-h="${hIdx}" style="padding:3px 10px;font-size:10px">${actLabel}</button>`;
            }
            if (e.success && e.action !== "test" && e.action !== "undo") {
                h += `<button class="glass-btn" onclick="R.undoOperation('${e.id}')" style="padding:3px 10px;font-size:10px">Undo</button>`;
            }
            // Only where there is something to re-apply FROM: entries written
            // before rich history carry no metadata and the backend 409s.
            if (e.metadata && e.success && e.action !== "test" && e.action !== "undo") {
                h += `<button class="glass-btn hist-reapply" data-h="${hIdx}" style="padding:3px 10px;font-size:10px" title="Rename this file using the CURRENT template, without asking a provider again">Re-apply</button>`;
            }
            h += `</div>`;
            h += `</div>`;
            h += `<div style="font-size:10px;color:var(--txt3);line-height:1.6">`;
            h += `<div>From: ${esc(Path.basename(e.original))}</div>`;
            h += `<div>To: ${esc(Path.basename(e.destination))}</div>`;
            // What CineSort decided, not just what it did.
            const why = historySummary(e);
            if (why) h += `<div class="hist-meta">${esc(why)}</div>`;
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
        html += `<button class="glass-btn" onclick="R.exportHistoryCsv()" style="flex:1;font-size:11px" title="Every field, including the match reasoning">Export CSV</button>`;
        html += `<button class="glass-btn" onclick="R.clearHistory()" style="flex:1;font-size:11px">Clear History</button>`;
        html += `<button class="glass-btn" onclick="R.closeModal()" style="flex:1;font-size:11px">Close</button>`;
        html += `</div>`;
        html += `<p style="font-size:10px;color:var(--txt3);margin-top:8px">Keeps the last 1000 operations — export to keep a permanent record.</p>`;

        modalBody.innerHTML = html;
        // Same dispatch as the results modal's .res-act buttons.
        modalBody.querySelectorAll(".hist-reapply").forEach(btn => {
            btn.addEventListener("click", () => reapplyHistoryEntry(flat[Number(btn.dataset.h)]));
        });
        modalBody.querySelectorAll(".hist-act").forEach(btn => {
            btn.addEventListener("click", (ev) => {
                const e = flat[Number(btn.dataset.h)];
                if (!e) return;
                if (!e.success) {
                    R.copyPath(e.error || "unknown error", ev);
                } else if (canShowInFolder) {
                    R.showInFolderPath(e.destination);
                } else {
                    R.copyPath(e.destination, ev);
                }
            });
        });
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
        const musicTag = f.media_type === "music" ? `<span class="tag music" title="Audio file — matches via MusicBrainz">♪</span>` : "";
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
            const isHigh = isManual || m.pinned || m.score >= REVIEW_CONFIDENCE;
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
// Row the open menu refers to. Items carry only a data-act marker and the
// dispatcher below reads these — no filename or path ever travels through an
// HTML attribute (esc() doesn't escape quotes, so inline onclick with a
// quoted path broke — and was attribute-injectable — for names like
// "Ocean's Eleven"; same bug class the results modal fixed with listeners).
let ctxIdx = null, ctxPane = null;

function createContextMenu() {
    const menu = document.createElement("div");
    menu.className = "context-menu glass-panel";
    menu.style.display = "none";
    // ONE delegated listener for every menu item, bound once at creation —
    // innerHTML rebuilds on each open can never detach it.
    menu.addEventListener("click", e => {
        const item = e.target.closest("[data-act]");
        if (!item || item.classList.contains("ctx-disabled")) return;
        const act = item.dataset.act;
        hideContextMenu();
        const f = scannedFiles[ctxIdx];
        switch (act) {
            case "remove": R.removeFile(ctxIdx); break;
            case "copy":   if (f) R.copyPath(f.path, e); break;
            case "reveal": R.showInFolder(ctxIdx); break;
            case "search": R.searchMetadata(ctxIdx); break;
            case "edit":   R.startInlineEdit(ctxIdx); break;
            case "meta":   R.showMetadata(ctxIdx); break;
            case "clear":  R.clearManual(ctxIdx); break;
            case "shift":  R.shiftEpisodes(ctxIdx); break;
        }
    });
    document.body.appendChild(menu);
    return menu;
}

/* Shift every episode number in one detection group.

   Anime rips use ABSOLUTE numbering ("Show - 105.mkv"), and some packs start
   at E00: the whole season lands on the wrong episode, and the only fix today
   is editing 24 rows by hand. The backend already honours per-file
   season/episode (MatchRequest.files), so this rewrites them and re-matches —
   no backend change at all. */
async function shiftEpisodes(idx) {
    const anchor = scannedFiles[idx];
    if (!anchor) return;
    const groupKey = anchor.clean_name;
    const group = scannedFiles.filter(f => f && f.clean_name === groupKey
                                            && typeof f.episode === "number");
    if (!group.length) {
        status("No episode numbers to shift in this group");
        setTimeout(() => statusHide(), 2500);
        return;
    }

    const lowest = Math.min(...group.map(f => f.episode));
    const highest = Math.max(...group.map(f => f.episode));
    const answer = await promptDialog(`Shift ${group.length} episode(s) of "${groupKey}"`, [
        { name: "offset", label: "Episode offset", placeholder: "-100",
          hint: `Currently E${lowest}–E${highest}. Use -${lowest - 1} to start at E1.` },
        { name: "season", label: "Season (leave empty to keep)", placeholder: "" },
    ], { okText: "Shift & re-match" });
    if (!answer) return;

    const offset = parseInt(answer.offset, 10);
    if (!Number.isFinite(offset)) {
        status("Offset must be a whole number, e.g. -100");
        setTimeout(() => statusHide(), 3000);
        return;
    }
    let season = null;
    if (answer.season !== "") {
        season = parseInt(answer.season, 10);
        if (!Number.isFinite(season) || season < 0) {
            status("Season must be a whole number (0 = specials)");
            setTimeout(() => statusHide(), 3000);
            return;
        }
    }
    // Checked BEFORE anything is written: a partially-applied shift would
    // leave the group in a state the user cannot reason about.
    if (lowest + offset < 1) {
        status(`Offset would produce episode ${lowest + offset} — nothing changed`);
        setTimeout(() => statusHide(), 3500);
        return;
    }

    group.forEach(f => {
        f.episode += offset;
        if (typeof f.episode_end === "number") f.episode_end += offset;
        if (season !== null) f.season = season;
        // Absolute numbering is what made the file wrong; keep it from
        // out-voting the numbers we just set.
        f.absolute = null;
        // The group is being re-evaluated from scratch — an earlier pinned
        // pick should not survive a renumbering.
        delete f.pinned;
    });

    status(`Shifted ${group.length} file(s) by ${offset >= 0 ? "+" : ""}${offset}` +
           (season !== null ? ` into season ${season}` : "") + " — re-matching…");
    doMatch();
}

function showContextMenu(e, idx, pane) {
    e.preventDefault();
    focusRow(idx); // focus the right-clicked row so DEL works for the next one
    if (!contextMenu) contextMenu = createContextMenu();
    ctxIdx = idx;
    ctxPane = pane;

    const f = scannedFiles[idx];
    const m = matchResults[idx];

    let html = `<div class="ctx-item ctx-delete" data-act="remove"><span>🗑 Remove from list</span><kbd>Del</kbd></div>`;
    html += `<div class="ctx-sep"></div>`;
    if (pane === "left" && f) {
        html += `<div class="ctx-item" data-act="copy">📋 Copy path</div>`;
        // "Show in folder" works only on desktop (Electron exposes shell). In
        // Docker/browser there is no OS file manager to reveal into, so it stays
        // disabled rather than silently doing nothing.
        if (canShowInFolder) {
            html += `<div class="ctx-item" data-act="reveal">📁 Show in folder</div>`;
        } else {
            html += `<div class="ctx-item ctx-disabled" title="Available in the desktop app">📁 Show in folder</div>`;
        }
    }
    if (pane === "right") {
        html += `<div class="ctx-item" data-act="search">🔍 Search metadata…</div>`;
        html += `<div class="ctx-item" data-act="edit"><span>✏ Edit name manually</span><kbd>F2</kbd></div>`;
        if (m && m.matched && !m.manual) {
            html += `<div class="ctx-item" data-act="meta">ℹ️ View metadata</div>`;
        }
        if (m && m.matched && m.manual) {
            html += `<div class="ctx-item" data-act="clear">↺ Clear manual name</div>`;
        }
        // Only for series files that actually carry an episode number — the
        // whole group is renumbered, so it is a group action shown on a row.
        if (f && f.media_type === "series" && typeof f.episode === "number") {
            html += `<div class="ctx-sep"></div>`;
            html += `<div class="ctx-item" data-act="shift">↔ Shift episode numbers…</div>`;
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
    /* Replace: accept this rename over the file already on disk. The existing
       file is MOVED aside by the backend (.replaced-<timestamp>), never
       deleted, and both moves land in one history batch so Undo restores the
       original layout. Marked on the match result so doRename carries it. */
    conflictReplace(ci) {
        const c = _activeConflicts[ci];
        if (!c || c.type !== "file_exists") return;
        const idx = _findIdxByOriginal(c.file);
        if (idx < 0) return;
        matchResults[idx].replace_existing = true;
        selectedSet.add(idx);            // Skip may have removed it earlier
        _activeConflicts.splice(ci, 1);
        renderLeft();
        renderRight();
        renderConflictsDialog();
        status(`Will replace ${Path.basename(c.destination)} — the existing file is kept as .replaced-…`);
        setTimeout(() => statusHide(), 2500);
    },
    /* Keep largest: one-click duplicate triage. Keeps the biggest known
       source SELECTED and deselects the rest (Skip's mechanism, applied in
       bulk) — smaller files stay in the list, unchecked, one click away from
       reversal. First wins ties, and the status says so. */
    conflictKeepLargest(ci) {
        const c = _activeConflicts[ci];
        if (!c || c.type !== "duplicate_destination") return;
        const known = c._origs
            .map(orig => _findIdxByOriginal(orig))
            .filter(idx => idx >= 0);
        if (known.length < 2) return;   // rows were removed meanwhile — nothing to triage
        let maxIdx = known[0];
        for (const idx of known) {
            if ((scannedFiles[idx].size || 0) > (scannedFiles[maxIdx].size || 0)) maxIdx = idx;
        }
        const tie = known.some(idx => idx !== maxIdx
            && (scannedFiles[idx].size || 0) === (scannedFiles[maxIdx].size || 0));
        for (const idx of known) {
            if (idx !== maxIdx) selectedSet.delete(idx);
        }
        _activeConflicts.splice(ci, 1);
        renderLeft();
        renderRight();
        renderConflictsDialog();
        status(`Kept largest: ${Path.basename(scannedFiles[maxIdx].path)}${tie ? " (tie — kept first)" : ""}`);
        setTimeout(() => statusHide(), 2000);
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

        // Identity block: the fields that answer "is this the right match?".
        // Built separately so it can sit beside the poster when one exists.
        let idFields = "";
        if (m.metadata?.show) {
            idFields += `<div><strong>Show:</strong> ${esc(m.metadata.show)}</div>`;
            idFields += `<div><strong>Season:</strong> ${m.metadata.season} <strong>Episode:</strong> ${m.metadata.episode}</div>`;
            if (m.metadata.title) idFields += `<div><strong>Title:</strong> ${esc(m.metadata.title)}</div>`;
        } else if (m.metadata?.title) {
            idFields += `<div><strong>Title:</strong> ${esc(m.metadata.title)}</div>`;
            if (m.metadata.year) idFields += `<div><strong>Year:</strong> ${m.metadata.year}</div>`;
        }
        // Episode synopsis / movie plot — providers sent it, show it where
        // the user verifies the match.
        if (m.metadata?.overview) {
            idFields += `<div style="font-size:11px;color:var(--txt3);margin-top:4px;line-height:1.5">${esc(m.metadata.overview)}</div>`;
        }
        // Which provider supplied the match — "(fallback)" when the selected
        // source found nothing and the other TV source stepped in. Labeled
        // "Metadata source" because "Source" below is the release tag (BluRay…).
        if (m.metadata?.datasource) {
            idFields += `<div><strong>Metadata source:</strong> ${esc(m.metadata.datasource.toUpperCase())}${m.metadata.fallback ? " (fallback)" : ""}</div>`;
        }
        if (m.metadata?.poster) {
            // Same esc(url)-in-src pattern the disambiguation/search dialogs use.
            html += `<div style="display:flex;gap:12px;align-items:flex-start">
                <img src="${esc(m.metadata.poster)}" alt=""
                     style="width:92px;height:138px;object-fit:cover;border-radius:6px;flex-shrink:0;background:var(--surface-2)">
                <div style="flex:1;min-width:0">${idFields}</div>
            </div>`;
        } else {
            html += idFields;
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

            let url = `/api/search?q=${encodeURIComponent(q || "x")}&type=${t}&datasource=${ds}`;
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

        // "tv" comes from a TMDb/TVmaze title search; "series" is OMDb's own
        // word, returned by the IMDb-ID lookup. Both are shows and must take
        // the show flow — testing only for "tv" sent every tt-ID series pick
        // into the movie branch, where the backend silently discarded it.
        if (c.type === "tv" || c.type === "series") {
            // The show flow needs a numeric provider id. A TMDb id resolved
            // from the tt-ID (backend /api/search) is preferred; c.id is only
            // numeric for a title search. An OMDb series that could not be
            // resolved leaves the tt-string here — refuse honestly rather
            // than POST a string the backend would fail to use.
            // TVmaze resolves a tt-ID with no API key at all, so a
            // TMDb-less deployment gets a usable id here too.
            const showId = c.tmdb_id ?? c.tvmaze_id ?? c.id;
            if (typeof showId !== "number") {
                statusDone("No TV database has a series record for that IMDb ID — search by title instead.");
                return;
            }
            // Send the source the id actually BELONGS to, not whatever the
            // Source dropdown happens to show: a TMDb id posted with
            // datasource "tvmaze" fetches a different show entirely.
            const ds = c.tmdb_id ? "tmdb"
                : (c.tvmaze_id || c.datasource === "tvmaze") ? "tvmaze" : "tmdb";
            // Whole detection group — mirrors the backend's grouping key.
            window._pendingMatchFiles = scannedFiles.filter(
                x => x.clean_name === f.clean_name
            );
            await R.selectShow(showId, c.title, null, ds);
            return;
        }

        // Movie: re-match through the backend by exact id — the SAME
        // pipeline auto-matches use, so {tmdbid}/{imdbid}/{y}, score_detail,
        // poster and overview all come out real. (The old client-side
        // formatting forced score 1.0, emptied the id tokens, and duplicated
        // build_new_path's sanitize in JS.)
        window._pendingMatchFiles = [f];
        await R.selectMovie(c.id, c.datasource);
    },

    /* Movie twin of selectShow: re-POST /api/match with the exact picked id.
       Merge like selectShow — but do NOT run the confidence gate over the
       picked rows: an explicit pick is consent. The score stays honest
       (name-similarity against a deliberately-picked title can be low); the
       SELECTION reflects the user's decision. */
    async selectMovie(movieId, movieSource, e) {
        if (e && e.target) {
            e.target.disabled = true;
            e.target.textContent = "Loading...";
        }
        modalOverlay.classList.add("hidden");
        status("Matching…", undefined, "match");

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
                        output_dir: elDest?.value.trim() || null,
                    selected_movie_id: String(movieId),
                    selected_movie_source: movieSource,
                }),
            });
            if (gen !== sessionGen) return;   // user hit "start over" meanwhile

            if (matchResults.length !== scannedFiles.length) {
                matchResults = new Array(scannedFiles.length).fill(null);
            }
            const resultMap = new Map();
            for (const r of data.results) {
                resultMap.set(r.original, r);
            }
            let matched = 0, name = "";
            for (let i = 0; i < scannedFiles.length; i++) {
                const r = resultMap.get(scannedFiles[i].path);
                if (r) {
                    matchResults[i] = r;
                    if (r.matched) {
                        matched++;
                        name = r.metadata?.title || name;
                        selectedSet.add(i);   // explicit pick = consent
                    }
                }
            }
            renderLeft();
            renderRight();
            renderGutter();
            updateFooter();
            statusDone(matched
                ? `Matched ${matched} file(s) with ${name}`
                : "Match failed — the selected movie could not be fetched");
        } catch (err) {
            statusDone("Match failed: " + err.message);
        } finally {
            clearInterval(ticker);
        }

        delete window._pendingMatchFiles;
    },

    async selectShow(showId, showName, e, dsOverride) {
        if (e && e.target) {
            e.target.disabled = true;
            e.target.textContent = "Loading...";
        }
        
        modalOverlay.classList.add("hidden");
        status(`Matching against ${showName}…`, undefined, "match");

        const filesToMatch = window._pendingMatchFiles || [];
        const ticker = startMatchProgressTicker();
        const gen = sessionGen;

        try {
            const data = await api("/api/match", {
                method: "POST",
                body: JSON.stringify({
                    // dsOverride: the provider the picked id belongs to.
                    // Omitted by the disambiguation dialog, whose candidate
                    // ids come from req.datasource by construction — so the
                    // dropdown is the right answer there.
                    files: filesToMatch,
                    datasource: dsOverride || elSource.value,
                    template: elTemplate.value,
                        output_dir: elDest?.value.trim() || null,
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
                if (r) {
                    matchResults[i] = r;
                    // Explicit pick = consent, the rule selectMovie already
                    // follows. Without it the gate below deselects the very
                    // rows the user just fixed by hand.
                    if (r.matched && r.pinned) selectedSet.add(i);
                }
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
            updateTemplatePreview();   // first row may have changed — re-sample it
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
    
    exportHistoryCsv() { exportHistoryCsv(); },
    shiftEpisodes(idx) { return shiftEpisodes(idx); },
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
        // Naming a file IS consent to rename it — the same rule the explicit
        // id-pick paths follow. Without this a row the confidence gate had
        // deselected (precisely the rows people hand-name) keeps its
        // deselection through the edit, and Rename silently skips the file
        // the user just named.
        selectedSet.add(idx);

        renderLeft();     // restore the checkbox + undim the left row
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
/* [data-template] scope: custom saved presets (renderCustomPresets) share
   the .preset-btn class for styling but carry their template in a closure,
   not a data attribute — binding this handler to them would clobber the
   applied value with the string "undefined". */
document.querySelectorAll(".preset-btn[data-template]").forEach(btn => {
    btn.addEventListener("click", () => {
        elTemplate.value = btn.dataset.template;
        persistPrefs();
        updateTemplatePreview();
    });
});

/* ─── Template tokens ─────────────────────────────────────────────
   The insert palette moved to Settings → Template tokens (density pass).
   The "tokens" link beside the Template label opens Settings scrolled to
   the reference card — the same scroll-to mechanism the update banner uses. */
$id("tokens-link")?.addEventListener("click", () => showSettings("tokens"));

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
$id("bulk-high")?.addEventListener("click", () => bulkSelect(m =>
    !!(m && m.matched && (m.manual || m.pinned || m.score >= REVIEW_CONFIDENCE))));
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
/* Media-appropriate placeholder per preset kind, so a no-files preview reads
   as what it actually produces — "Movie Name (2024)" for Film, not the TV-ish
   "Show Name". Flat reuses TV (it's a TV rename in place). */
const PRESET_SAMPLE = {
    TV:    { clean_name: "Series Name", year: 2024, season: 1, episode: 1, title: "Pilot", media_type: "series" },
    Film:  { clean_name: "Movie Name",  year: 2024, media_type: "movie" },
    Anime: { clean_name: "Anime Name",  year: 2024, absolute: 1, title: "The Journey Begins", media_type: "series" },
    Flat:  { clean_name: "Series Name", year: 2024, season: 1, episode: 1, title: "Pilot", media_type: "series" },
    Music: { artist: "Artist", album: "Album", track: 1, title: "Song Title", media_type: "music" },
};

/* Best-effort kind from a custom template's tokens (for the badge + sample when
   the template matches no named preset). */
function inferKind(tpl) {
    if (/\{artist\}|\{album\}|\{track\}/.test(tpl)) return "Music";
    if (/\{absolute\}/.test(tpl)) return "Anime";
    if (/\{s00e00\}|\{season\}|\{s\}|\{e\}|\{title\}/.test(tpl)) return "TV";
    if (/\{year\}|\{y\}/.test(tpl)) return "Film";
    return null;
}

/* Which built-in preset buttons exist (direct children only — custom presets
   live in #custom-presets and carry their template in a closure, not a
   data-template attribute). */
function builtinPresetButtons() {
    return [...document.querySelectorAll(".template-presets > .preset-btn[data-template]")];
}

/* Highlight the preset (built-in OR custom) matching the current template, and
   return the label to badge the preview with. Runs on every template change. */
function highlightActivePreset() {
    const cur = elTemplate.value.trim();
    let label = null;
    builtinPresetButtons().forEach(b => {
        const on = b.dataset.template === cur;
        b.classList.toggle("active", on);
        if (on) label = b.textContent.trim();
    });
    const custom = (typeof loadCustomPresets === "function") ? loadCustomPresets() : [];
    const customBtns = document.querySelectorAll("#custom-presets .preset-btn");
    custom.forEach((p, i) => {
        const on = p.template === cur;
        customBtns[i]?.classList.toggle("active", on);
        if (on && label === null) label = p.label;
    });
    return label;
}

/* {label, sample} for the preview: the matched preset's kind + placeholder, or
   an inferred kind for a custom template, or "Custom" with no override. */
function templateKindInfo() {
    const cur = elTemplate.value.trim();
    const btn = builtinPresetButtons().find(b => b.dataset.template === cur);
    if (btn) { const k = btn.textContent.trim(); return { label: k, sample: PRESET_SAMPLE[k] || null }; }
    const inferred = inferKind(cur);
    // A saved custom preset shows its own name (more specific); an unsaved
    // custom shows the inferred media kind so the badge matches the preview;
    // otherwise just "Custom".
    const cust = ((typeof loadCustomPresets === "function") ? loadCustomPresets() : []).find(p => p.template === cur);
    const label = cust ? cust.label : (inferred || "Custom");
    return { label, sample: inferred ? PRESET_SAMPLE[inferred] : null };
}

let _previewTimer = null;
function updateTemplatePreview() {
    const el = $id("template-preview");
    if (!el) return;
    highlightActivePreset();
    const tpl = elTemplate.value.trim();
    if (!tpl) { el.textContent = ""; return; }
    const info = templateKindInfo();
    // A real scanned file always wins; otherwise a media-appropriate sample so
    // the placeholder matches the chosen preset.
    const idx = scannedFiles.findIndex((_, i) => selectedSet.has(i));
    const sample = scannedFiles[idx] || scannedFiles[0] || info.sample || {};
    clearTimeout(_previewTimer);
    _previewTimer = setTimeout(async () => {
        try {
            const data = await api("/api/preview-template", {
                method: "POST",
                body: JSON.stringify({ template: tpl, sample }),
            });
            el.classList.remove("preview-error");
            el.textContent = "";
            const badge = document.createElement("span");
            badge.className = "preview-kind";
            badge.textContent = info.label;                 // fixed set / user label — set as text, never markup
            const path = document.createElement("span");
            path.className = "preview-path";
            path.textContent = data.preview ? "→ " + data.preview : "";
            el.append(badge, path);
            // An unrecognised token renders as literal text in the name, which
            // reads as a bug rather than a typo — say which one.
            if (data.unknown && data.unknown.length) {
                const warning = document.createElement("span");
                warning.className = "preview-unknown";
                warning.textContent = "  ⚠ unknown: " + data.unknown.map(t => `{${t}}`).join(" ");
                el.appendChild(warning);
            }
        } catch (err) {
            el.textContent = "⚠ " + err.message;
            el.classList.add("preview-error");
        }
    }, 250);
}
elTemplate.addEventListener("input", () => { persistPrefs(); updateTemplatePreview(); });

/* Let a filename be mouse-selected even though its row is draggable: pressing
   on .row-text disables that row's drag just for this gesture, so dragging
   across the name SELECTS it; releasing restores drag so reorder/remap still
   works from the rest of the row (checkbox, icon, tags, padding). Delegated on
   the persistent list containers so it survives the frequent innerHTML
   re-renders. Confirmed the only reliable way to select text in a draggable
   row — the drag otherwise always wins. */
let _selDragRow = null;
function armRowTextSelect(e) {
    if (e.button !== 0) return;                       // left button only
    const txt = e.target.closest(".row-text");
    if (!txt) return;
    const row = txt.closest(".row-item");
    if (row && row.getAttribute("draggable") === "true") {
        row.setAttribute("draggable", "false");
        _selDragRow = row;
    }
}
leftList.addEventListener("mousedown", armRowTextSelect);
rightList.addEventListener("mousedown", armRowTextSelect);
document.addEventListener("mouseup", () => {
    if (_selDragRow) { _selDragRow.setAttribute("draggable", "true"); _selDragRow = null; }
});

/* ─── Keyboard shortcuts ──────────────────────────────────── */
document.addEventListener("keydown", e => {
    // F2: edit focused row name manually
    if (e.key === "F2" && focusedIdx !== null && scannedFiles.length > 0) {
        e.preventDefault();
        R.startInlineEdit(focusedIdx);
        return;
    }
    // Ctrl/Cmd+C: copy the focused row's path — but only when the user isn't
    // typing and hasn't selected text (a real selection copies natively).
    if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
        const inEditable = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
        const hasSelection = !!(window.getSelection && window.getSelection().toString().trim());
        if (!inEditable && !hasSelection && focusedIdx !== null && scannedFiles[focusedIdx]) {
            e.preventDefault();
            R.copyPath(scannedFiles[focusedIdx].path);
        }
        return;
    }
    // Delete: remove selected files (skip when editing inline)
    if (e.key === "Delete" && scannedFiles.length > 0 && !document.querySelector(".row-edit-input")) {
        e.preventDefault();
        removeSelected();
    }
    // Ctrl+A: select all FILES — but not while a dialog is open (there the
    // browser's native select-all should work on the dialog's text) or while
    // editing inline.
    if (e.key === "a" && e.ctrlKey && scannedFiles.length > 0
            && modalOverlay.classList.contains("hidden")
            && !document.querySelector(".row-edit-input")) {
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
    updateTemplatePreview();   // preview samples scannedFiles[0] — re-sync after removal
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
    updateTemplatePreview();   // preview samples scannedFiles[0] — re-sync after removal
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
