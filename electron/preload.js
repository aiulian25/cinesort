const { contextBridge, webUtils } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    isElectron: true,
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
});
