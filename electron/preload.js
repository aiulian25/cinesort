const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    isElectron: true,
    // Open the native OS file/folder picker (main process owns the dialog).
    // Resolves to an array of absolute paths, or [] if the user cancelled.
    // `opts.properties` is a subset of Electron's dialog properties; the main
    // process clamps it to a safe whitelist.
    pickPaths: (opts) => ipcRenderer.invoke("dialog:open", opts),
    // Reveal a path in the OS file manager. Resolves to true if handled.
    showInFolder: (fullPath) => ipcRenderer.invoke("shell:showItem", fullPath),
    // webUtils.getPathForFile() is the Electron 32+ supported way to resolve
    // the real filesystem path from a File object dropped into the renderer.
    // We guard against failures so a broken sandbox or missing API never
    // surfaces as an uncaught exception in the renderer.
    getPathForFile: (file) => {
        try {
            return webUtils.getPathForFile(file) || "";
        } catch (err) {
            console.error("[preload] getPathForFile failed:", err.message);
            return "";
        }
    },
    // One-click update download (Settings). The main process picks the right
    // deb/rpm/AppImage for this install, verifies size + sha256, saves to
    // ~/Downloads and reveals it. Resolves {ok, name, file, pkgType} or
    // {ok:false, error}. Takes no arguments by design — the renderer cannot
    // influence what is downloaded or from where.
    downloadUpdate: () => ipcRenderer.invoke("update:download"),
    // Install the update downloadUpdate() verified. deb/rpm go through the
    // system package manager under polkit authorization; AppImage is replaced
    // in place. Takes no arguments by design — the main process only installs
    // the file it downloaded itself, re-hashed immediately before install.
    installUpdate: () => ipcRenderer.invoke("update:install"),
    // Download progress callback (0-100). Re-registering replaces the previous
    // listener so reopening Settings can't stack duplicates.
    onUpdateProgress: (cb) => {
        ipcRenderer.removeAllListeners("update:download-progress");
        ipcRenderer.on("update:download-progress", (_evt, pct) => cb(pct));
    },
});
