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
let draggedIdx = null;   // index being dragged
let draggedFrom = null;  // 'left' or 'right'
let focusedIdx = null;   // keyboard-focused row (DEL/arrow navigation)

/* ─── DOM refs ────────────────────────────────────────────── */
const $ = s => document.querySelector(s);
const $id = s => document.getElementById(s);

const elScanPath  = $id("scan-path");
const elRecursive = $id("recursive");
const elTemplate  = $id("template");
const elSource    = $id("datasource");
const elAction    = $id("action");

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
        <button class="glass-btn" onclick="modalOverlay.classList.add('hidden')" style="flex:1">Cancel</button>
    </div>`;
    
    modalBody.innerHTML = html;
    modalOverlay.classList.remove("hidden");
    
    // Store filesToMatch for the selection callback
    window._pendingMatchFiles = filesToMatch;
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
        <button class="glass-btn" onclick="modalOverlay.classList.add('hidden')" style="flex:1">Cancel</button>
    </div>`;
    
    modalBody.innerHTML = html;
    modalOverlay.classList.remove("hidden");
    
    // Store filesToMatch for the selection callback
    window._pendingMatchFiles = filesToMatch;
}

function showConflictsDialog(conflicts) {
    modalTitle.textContent = "⚠️ Rename Conflicts Detected";
    
    let html = `<p style="color:var(--txt2);margin-bottom:12px;font-size:12px">${conflicts.length} conflict(s) found. Review before renaming:</p>`;
    html += `<div style="max-height:300px;overflow-y:auto;display:flex;flex-direction:column;gap:8px">`;
    
    for (const c of conflicts) {
        if (c.type === "duplicate_destination") {
            html += `<div style="padding:10px;background:rgba(255,180,0,0.1);border:1px solid rgba(255,180,0,0.3);border-radius:6px">`;
            html += `<div style="font-weight:500;font-size:11px;color:#ffb400;margin-bottom:4px">⚠ Duplicate Destination</div>`;
            html += `<div style="font-size:10px;color:var(--txt2);margin-bottom:4px">${esc(c.message)}</div>`;
            html += `<div style="font-size:10px;color:var(--txt3)">${c.files.map(f => `<div>• ${esc(Path.basename(f))}</div>`).join('')}</div>`;
            html += `</div>`;
        } else if (c.type === "file_exists") {
            html += `<div style="padding:10px;background:rgba(255,60,60,0.1);border:1px solid rgba(255,60,60,0.3);border-radius:6px">`;
            html += `<div style="font-weight:500;font-size:11px;color:#ff4444;margin-bottom:4px">⛔ File Exists</div>`;
            html += `<div style="font-size:10px;color:var(--txt2)">${esc(c.message)}</div>`;
            html += `<div style="font-size:10px;color:var(--txt3);margin-top:4px">Source: ${esc(Path.basename(c.file))}</div>`;
            html += `</div>`;
        }
    }
    
    html += `</div>`;
    html += `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">`;
    html += `<p style="font-size:10px;color:var(--txt3);margin-bottom:8px">Tip: Adjust matches manually by dragging rows, or skip conflicting files before renaming.</p>`;
    html += `<button class="glass-btn" onclick="modalOverlay.classList.add('hidden')" style="width:100%">Got it</button>`;
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
    // Refresh the right pane so the preview reflects the new action mode
    if (matchResults.some(r => r && r.matched)) renderRight();
});
updateActionHint(); // run once on load


elScanPath.addEventListener("keydown", e => { if (e.key === "Enter") doScan(); });

/* ─── Browse ──────────────────────────────────────────────── */
btnBrowse.addEventListener("click", () => showBrowseDialog("/mnt"));

async function showBrowseDialog(startPath) {
    modalTitle.textContent = "Browse Server Folders";
    let selectedPaths = new Set();
    let currentItems = [];
    
    async function loadPath(path) {
        try {
            const data = await api(`/api/browse?path=${encodeURIComponent(path)}`);
            currentItems = data.items;
            selectedPaths.clear(); // Clear selection when navigating
            renderBrowser(data.path, data.items);
        } catch (err) {
            renderBrowser(path, [], err.message);
        }
    }
    
    function renderBrowser(currentPath, items, error = null) {
        let html = `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:8px;background:var(--glass-bg);border:1px solid var(--border);border-radius:8px">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <code style="flex:1;font-size:11px;color:var(--txt2);font-family:var(--font-mono);user-select:all">${esc(currentPath)}</code>
            </div>`;
        
        if (error) {
            html += `<p style="color:var(--red);font-size:11px;padding:8px;background:rgba(255,80,80,0.1);border-radius:6px;margin-bottom:12px">${esc(error)}</p>`;
        }
        
        html += `<div id="browser-list" tabindex="0" style="max-height:400px;overflow-y:auto;margin-bottom:12px;border:1px solid var(--border);border-radius:8px;outline:none">`;
        
        if (items.length === 0 && !error) {
            html += `<div style="padding:20px;text-align:center;color:var(--txt3);font-size:11px">Empty directory</div>`;
        }
        
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const icon = item.type === "parent" ? "↩️" :
                        item.type === "directory" ? "📁" : "📄";
            const size = item.size !== null ? fmt(item.size) : "";
            const isDir = item.type === "directory" || item.type === "parent";
            const isParent = item.type === "parent";
            const classes = isDir ? "browser-item browser-dir" : "browser-item";
            const checked = selectedPaths.has(item.path) ? "checked" : "";
            
            // Don't show checkbox for parent directory
            const checkbox = isParent ? "" : `<input type="checkbox" ${checked} data-idx="${i}" style="margin-right:4px;cursor:pointer">`;
            
            html += `<div class="${classes}" data-path="${esc(item.path)}" data-idx="${i}" data-is-dir="${isDir}" data-is-parent="${isParent}">
                ${checkbox}
                <span style="font-size:16px;margin-right:8px">${icon}</span>
                <span style="flex:1;font-size:11px;color:var(--txt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.name)}</span>
                ${size ? `<span style="font-size:10px;color:var(--txt3);margin-left:8px">${size}</span>` : ""}
            </div>`;
        }
        
        html += `</div>`;
        
        const selectedCount = selectedPaths.size;
        const selectText = selectedCount > 0 ? `Scan ${selectedCount} Selected` : "Scan Current Folder";
        
        html += `<div style="display:flex;gap:8px;margin-bottom:8px">
            <button class="glass-btn" id="browse-select-all" style="flex:1;font-size:11px">Select All</button>
            <button class="glass-btn" id="browse-deselect-all" style="flex:1;font-size:11px">Deselect All</button>
        </div>`;
        html += `<div style="display:flex;gap:8px">
            <button class="glass-btn" onclick="modalOverlay.classList.add('hidden')" style="flex:1">Cancel</button>
            <button class="glass-btn btn-scan" id="browse-select" style="flex:2">${selectText}</button>
        </div>`;
        
        modalBody.innerHTML = html;
        
        const browserList = $id("browser-list");
        
        // Add keyboard handler for Ctrl+A
        browserList.addEventListener("keydown", (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "a") {
                e.preventDefault();
                selectAll();
            }
        });
        
        // Focus the list for keyboard shortcuts
        setTimeout(() => browserList.focus(), 50);
        
        // Add checkbox change handlers
        const checkboxes = modalBody.querySelectorAll('input[type="checkbox"]');
        for (const cb of checkboxes) {
            cb.addEventListener("change", (e) => {
                e.stopPropagation();
                const idx = parseInt(cb.getAttribute("data-idx"));
                const item = items[idx];
                if (cb.checked) {
                    selectedPaths.add(item.path);
                } else {
                    selectedPaths.delete(item.path);
                }
                updateSelectButton();
            });
        }
        
        // Add click handlers for navigation
        const browserItems = modalBody.querySelectorAll(".browser-item");
        for (const itemEl of browserItems) {
            itemEl.addEventListener("click", (e) => {
                // If clicking checkbox, let it handle itself
                if (e.target.tagName === "INPUT") return;
                
                const path = itemEl.getAttribute("data-path");
                const isDir = itemEl.getAttribute("data-is-dir") === "true";
                const isParent = itemEl.getAttribute("data-is-parent") === "true";
                const idx = itemEl.getAttribute("data-idx");
                
                // Parent directory: navigate up
                if (isParent) {
                    loadPath(path);
                    return;
                }
                
                // Directory: toggle checkbox or navigate on double-click
                if (isDir) {
                    const checkbox = itemEl.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        checkbox.checked = !checkbox.checked;
                        checkbox.dispatchEvent(new Event("change"));
                    }
                }
            });
            
            // Double-click on directory to navigate into it
            itemEl.addEventListener("dblclick", (e) => {
                const path = itemEl.getAttribute("data-path");
                const isDir = itemEl.getAttribute("data-is-dir") === "true";
                const isParent = itemEl.getAttribute("data-is-parent") === "true";
                
                if ((isDir || isParent) && !e.target.matches('input[type="checkbox"]')) {
                    loadPath(path);
                }
            });
        }
        
        function selectAll() {
            selectedPaths.clear();
            items.forEach(item => {
                if (item.type !== "parent") {
                    selectedPaths.add(item.path);
                }
            });
            renderBrowser(currentPath, items, error);
        }
        
        function deselectAll() {
            selectedPaths.clear();
            renderBrowser(currentPath, items, error);
        }
        
        function updateSelectButton() {
            const selectBtn = $id("browse-select");
            if (selectBtn) {
                const selectedCount = selectedPaths.size;
                selectBtn.textContent = selectedCount > 0 ? `Scan ${selectedCount} Selected` : "Scan Current Folder";
            }
        }
        
        // Add button handlers
        const selectAllBtn = $id("browse-select-all");
        const deselectAllBtn = $id("browse-deselect-all");
        if (selectAllBtn) selectAllBtn.addEventListener("click", selectAll);
        if (deselectAllBtn) deselectAllBtn.addEventListener("click", deselectAll);
        
        // Add select button handler
        const selectBtn = $id("browse-select");
        if (selectBtn) {
            selectBtn.addEventListener("click", async () => {
                modalOverlay.classList.add("hidden");
                
                // If items are selected, scan all of them
                if (selectedPaths.size > 0) {
                    const paths = Array.from(selectedPaths);
                    status(`Scanning ${paths.length} selected item(s)…`);
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
                        statusDone(`Found ${scannedFiles.length} media file(s) from ${paths.length} selected item(s)`);
                    } catch (err) {
                        statusDone("Scan failed: " + err.message);
                    }
                } else {
                    // No items selected, scan current folder
                    elScanPath.value = currentPath;
                    doScan();
                }
            });
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

    status("Matching against " + elSource.value.toUpperCase() + "…");
    btnMatch.disabled = true;

    try {
        const data = await api("/api/match", {
            method: "POST",
            body: JSON.stringify({
                files: filesToMatch,
                datasource: elSource.value,
                template: elTemplate.value,
            }),
        });

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
        html += `<button class="glass-btn" onclick="modalOverlay.classList.add('hidden')" style="flex:1;font-size:11px">Close</button>`;
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
        leftList.innerHTML = `
            <div class="drop-zone active" id="drop-zone">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.25">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/>
                    <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <p>Drop media files here</p>
                <p class="drop-hint">or enter a folder path above and click Scan</p>
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
                      onmouseenter="R.hoverRow(${i})" onmouseleave="R.unhoverRow(${i})"
                      oncontextmenu="R.showContextMenu(event, ${i}, 'left')"
                      ondragstart="R.dragStart(event, ${i}, 'left')"
                      ondragover="R.dragOver(event, ${i}, 'left')"
                      ondrop="R.drop(event, ${i}, 'left')"
                      ondragend="R.dragEnd(event)">
            <div class="row-cb"><input type="checkbox" ${checked} data-idx="${i}"></div>
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
function renderRight() {
    const matched = matchResults.filter(r => r && r.matched).length;
    rightCount.textContent = matched;

    if (matchResults.every(r => r === null)) {
        rightList.innerHTML = `<div class="empty-right"><p>Click <strong>Match</strong> to look up metadata</p></div>`;
        return;
    }

    let html = "";
    for (let i = 0; i < scannedFiles.length; i++) {
        const m = matchResults[i];
        if (!m) {
            html += `<div class="row-item" data-idx="${i}">
                <span class="row-text unmatched">—</span>
            </div>`;
            continue;
        }

        if (m.matched) {
            const scoreClass = m.score >= 0.6 ? "score-hi" : "score-lo";
            const poster = m.metadata?.poster
                ? `<img src="${esc(m.metadata.poster)}" alt="">`
                : fileIcon("matched");
            
            let metaLine = "";
            if (m.metadata?.show) {
                const title = m.metadata.title || "";
                const year = scannedFiles[i]?.year || "";
                metaLine = `<div class="meta-detail" title="${esc(title)}">`;
                metaLine += `<span class="meta-show">${esc(m.metadata.show)}</span>`;
                if (year) metaLine += ` <span class="meta-year">(${year})</span>`;
                metaLine += ` • <span class="meta-ep">S${String(m.metadata.season||0).padStart(2,"0")}E${String(m.metadata.episode||0).padStart(2,"0")}</span>`;
                if (title) metaLine += ` • <span class="meta-title">${esc(title)}</span>`;
                metaLine += `</div>`;
            } else if (m.metadata?.title) {
                const year = m.metadata.year || "";
                metaLine = `<div class="meta-detail"><span class="meta-show">${esc(m.metadata.title)}</span>`;
                if (year) metaLine += ` <span class="meta-year">(${year})</span>`;
                metaLine += `</div>`;
            }

            // For rename (in-place) show only the filename, not the full template path
            const displayName = elAction.value === "rename"
                ? (m.new_name || "")
                : (m.preview || m.new_name || "");

            html += `<div class="row-item" data-idx="${i}" draggable="true"
                          onmouseenter="R.hoverRow(${i})" onmouseleave="R.unhoverRow(${i})"
                          oncontextmenu="R.showContextMenu(event, ${i}, 'right')"
                          ondragstart="R.dragStart(event, ${i}, 'right')"
                          ondragover="R.dragOver(event, ${i}, 'right')"
                          ondrop="R.drop(event, ${i}, 'right')"
                          ondragend="R.dragEnd(event)">
                <div class="row-icon">${poster}</div>
                <div style="flex:1;min-width:0;">
                    <span class="row-text newname" title="${esc(displayName)}">${esc(displayName)}</span>
                    ${metaLine}
                </div>
                <div class="row-tags">
                    <span class="tag ${scoreClass}">${Math.round(m.score * 100)}%</span>
                </div>
            </div>`;
        } else {
            html += `<div class="row-item" data-idx="${i}">
                <span class="row-text unmatched">No match found</span>
            </div>`;
        }
    }
    rightList.innerHTML = html;

    // Row click → set keyboard focus
    rightList.querySelectorAll(".row-item[data-idx]").forEach(el => {
        el.addEventListener("click", e => {
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
        html += `<div class="ctx-item ctx-disabled">📁 Show in folder</div>`;
    }
    if (pane === "right" && m && m.matched) {
        html += `<div class="ctx-item" onclick="R.showMetadata(${idx})">ℹ️ View metadata</div>`;
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
    copyPath(path, e) {
        e?.stopPropagation();
        navigator.clipboard.writeText(path).then(() => {
            status("Copied to clipboard");
            setTimeout(() => statusHide(), 1500);
        });
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
        
        html += `<div style="margin-top:12px;color:var(--txt3);font-size:11px"><strong>Match score:</strong> ${Math.round(m.score * 100)}%</div>`;
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
        if (!confirm("Undo this rename operation? The file will be moved back to its original location.")) return;
        
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
        if (!confirm("Clear all history? This cannot be undone.")) return;
        
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
    });
});

/* ─── Keyboard shortcuts ──────────────────────────────────── */
document.addEventListener("keydown", e => {
    // Delete: remove selected files
    if (e.key === "Delete" && scannedFiles.length > 0) {
        e.preventDefault();
        removeSelected();
    }
    // Ctrl+A: select all
    if (e.key === "a" && e.ctrlKey && scannedFiles.length > 0) {
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
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2">
        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>
    </svg>`;
}

})();
