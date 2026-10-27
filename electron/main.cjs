// Folio desktop shell: one window, PDFs opened from Explorer / "Open with", files served over app://.
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { autoUpdater } = require("electron-updater");

const DIST = path.join(__dirname, "..", "dist");
const DEV_URL = process.env.FOLIO_DEV_URL; // e.g. http://localhost:5173 while developing

// Title bar colours follow the app theme (see src/styles.css --bg). Height is one pixel short of
// --topbar-h so the toolbar's bottom border runs underneath the window controls.
const TITLEBAR = {
  dark: { color: "#171717", symbolColor: "#edece9", height: 51 },
  light: { color: "#f5f4f1", symbolColor: "#1c1b19", height: 51 },
};

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let win = null;
let pendingFile = pdfFromArgs(process.argv);

function pdfFromArgs(argv) {
  const file = argv.slice(1).find((a) => !a.startsWith("-") && /\.pdf$/i.test(a) && fs.existsSync(a));
  return file ? path.resolve(file) : null;
}

function sendFile(file) {
  if (!file || !win) return;
  try {
    const data = fs.readFileSync(file);
    win.webContents.send("folio:open-file", { name: path.basename(file), data });
  } catch (err) {
    dialog.showErrorBox("Couldn't open file", `${file}\n\n${err.message}`);
  }
}

// ── Auto-update ──────────────────────────────────────────────────────
// Installed copies check GitHub Releases (mberman84/folio-releases, see "publish" in package.json)
// on launch and every few hours, download new versions in the background, and install them on quit
// or when the user clicks "Restart" in the update banner.
let updateReady = null;
const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;

function setupAutoUpdate() {
  // Only real installs can update themselves; skip dev runs. FOLIO_UPDATE_TEST lets the unpacked build be tested.
  if (!app.isPackaged && !process.env.FOLIO_UPDATE_TEST) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", (info) => {
    updateReady = info.version;
    win?.webContents.send("folio:update-ready", info.version);
  });
  autoUpdater.on("error", (err) => console.warn("[update]", err?.message || err));
  const check = () => autoUpdater.checkForUpdates().catch((err) => console.warn("[update]", err?.message || err));
  check();
  setInterval(check, UPDATE_INTERVAL_MS);
}

function createWindow() {
  const theme = "dark"; // the page reports its real theme on load via folio:theme
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 420,
    minHeight: 480,
    show: false,
    backgroundColor: TITLEBAR[theme].color,
    title: "Folio",
    icon: path.join(__dirname, "icon.png"),
    titleBarStyle: "hidden",
    titleBarOverlay: TITLEBAR[theme],
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      plugins: true, // Chromium's PDF viewer, used for printing
    },
  });

  win.once("ready-to-show", () => win.show());
  win.loadURL(DEV_URL || "app://folio/index.html");

  // Links inside PDFs open in the default browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://") && !(DEV_URL && url.startsWith(DEV_URL))) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  // The page blocks unload while annotations are unsaved; ask instead of silently refusing to close.
  win.webContents.on("will-prevent-unload", (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Close without saving", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: "Unsaved annotations",
      message: "You have highlights or notes that haven't been saved.",
      detail: "Press Ctrl+S in Folio to save a copy with your annotations.",
    });
    if (choice === 0) e.preventDefault();
  });

  win.on("closed", () => (win = null));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second launch (e.g. double-clicking another PDF) hands its file to the running window.
  app.on("second-instance", (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    sendFile(pdfFromArgs(argv));
  });

  app.whenReady().then(() => {
    protocol.handle("app", (req) => {
      const { pathname } = new URL(req.url);
      const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
      if (!file.startsWith(DIST)) return new Response("Forbidden", { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });

    ipcMain.handle("folio:ready", () => {
      const file = pendingFile;
      pendingFile = null;
      if (file) setTimeout(() => sendFile(file), 0);
      return true;
    });
    ipcMain.handle("folio:version", () => app.getVersion());
    ipcMain.handle("folio:update-status", () => updateReady);
    ipcMain.on("folio:install-update", () => {
      if (updateReady) autoUpdater.quitAndInstall(false, true);
    });
    ipcMain.on("folio:theme", (_e, theme) => {
      if (win && TITLEBAR[theme]) {
        win.setTitleBarOverlay(TITLEBAR[theme]);
        win.setBackgroundColor(TITLEBAR[theme].color);
      }
    });

    createWindow();
    setupAutoUpdate();
  });

  app.on("window-all-closed", () => app.quit());
}
