// Minimal bridge between the Folio page and the desktop shell.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("folioDesktop", {
  /** Called with { name, data: Uint8Array } whenever a PDF is opened from Explorer. */
  onOpenFile(callback) {
    ipcRenderer.on("folio:open-file", (_e, file) => callback(file.name, new Uint8Array(file.data)));
    ipcRenderer.invoke("folio:ready");
  },
  setTheme: (theme) => ipcRenderer.send("folio:theme", theme),
  getVersion: () => ipcRenderer.invoke("folio:version"),
  /** Called with the new version once an update has been downloaded and is ready to install. */
  onUpdateReady(callback) {
    ipcRenderer.on("folio:update-ready", (_e, version) => callback(version));
    ipcRenderer.invoke("folio:update-status").then((version) => version && callback(version));
  },
  installUpdate: () => ipcRenderer.send("folio:install-update"),
  /** Called with the updater state ({ state, version?, percent?, message? }) now and whenever it changes. */
  onUpdateStatus(callback) {
    const listener = (_e, status) => callback(status);
    ipcRenderer.on("folio:update-status-changed", listener);
    ipcRenderer.invoke("folio:update-state").then(callback);
    return () => ipcRenderer.removeListener("folio:update-status-changed", listener);
  },
  checkForUpdates: () => ipcRenderer.send("folio:check-update"),
});
