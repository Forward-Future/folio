// Minimal bridge between the Folio page and the desktop shell.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("folioDesktop", {
  /** Called with { name, data: Uint8Array } whenever a PDF is opened from Explorer. */
  onOpenFile(callback) {
    const listener = (_e, file) => callback(file.name, new Uint8Array(file.data));
    ipcRenderer.on("folio:open-file", listener);
    return () => ipcRenderer.removeListener("folio:open-file", listener);
  },
  ready: () => ipcRenderer.invoke("folio:ready"),
  /** Downloads a PDF from an http(s) link; resolves to { name, data: Uint8Array }. */
  async fetchPdf(url) {
    const file = await ipcRenderer.invoke("folio:fetch-pdf", url);
    if (file.error) throw new Error(file.error);
    return { name: file.name, data: new Uint8Array(file.data) };
  },
  getAppInfo: () => ipcRenderer.invoke("folio:app-info"),
  openInstallation: () => ipcRenderer.invoke("folio:open-installation"),
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
  getAutoUpdateEnabled: () => ipcRenderer.invoke("folio:auto-update-setting"),
  setAutoUpdateEnabled: (enabled) => ipcRenderer.invoke("folio:set-auto-update-setting", enabled),
});
