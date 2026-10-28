// Turns a webpage into a PDF: load it in a hidden, locked-down window, then print it with Chromium.
// The page runs in its own throwaway session (no cookies or storage shared with Folio or other
// captures), sandboxed, with no Node.js, no permissions, no pop-ups, and no downloads.
const { BrowserWindow, session } = require("electron");
const crypto = require("node:crypto");

const TOTAL_TIMEOUT_MS = 60_000;
const SCROLL_TIMEOUT_MS = 15_000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

function fileName(title, url) {
  const clean = String(title || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${clean || url.hostname}.pdf`;
}

// Scrolls through the page so lazy-loaded images load, then back to the top.
const PREPARE_PAGE = `(async () => {
  const pause = () => new Promise((r) => setTimeout(r, 120));
  document.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = "eager"; });
  for (let y = 0; y < document.documentElement.scrollHeight && y < 60000; y += Math.max(400, innerHeight * 0.8)) {
    scrollTo(0, y);
    await pause();
  }
  scrollTo(0, 0);
  await pause();
  return true;
})()`;

/**
 * Loads `rawUrl` and prints it to PDF. `isLocalHost(hostname)` identifies loopback/private hosts:
 * a public page may not make requests into the local network.
 * Resolves to { name, data } or { error }.
 */
async function captureWebpage(rawUrl, isLocalHost) {
  const url = new URL(rawUrl);
  const ses = session.fromPartition(`folio-webpage-${crypto.randomUUID()}`); // in-memory only
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  const publicPage = !isLocalHost(url.hostname);
  ses.webRequest.onBeforeRequest((details, callback) => {
    let target;
    try { target = new URL(details.url); } catch { return callback({ cancel: true }); }
    const web = target.protocol === "http:" || target.protocol === "https:";
    if (!web && target.protocol !== "data:" && target.protocol !== "blob:") return callback({ cancel: true });
    if (web && publicPage && isLocalHost(target.hostname)) return callback({ cancel: true });
    callback({});
  });

  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 1400,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  const contents = win.webContents;
  contents.setAudioMuted(true);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, next) => { if (!/^https?:/i.test(next)) event.preventDefault(); });

  try {
    return await withTimeout((async () => {
      try {
        await contents.loadURL(url.toString());
      } catch (error) {
        // Pages that keep redirecting or abort a subresource can reject even though they loaded.
        if (!contents.getURL() || contents.getURL() === "about:blank") throw error;
      }
      await delay(800);
      await withTimeout(contents.executeJavaScript(PREPARE_PAGE, true), SCROLL_TIMEOUT_MS, "scroll").catch(() => {});
      await delay(600);
      const data = await contents.printToPDF({
        printBackground: true,
        pageSize: "Letter",
        margins: { marginType: "default" },
        generateDocumentOutline: true,
        generateTaggedPDF: true,
      });
      return { name: fileName(contents.getTitle(), new URL(contents.getURL() || url.toString())), data };
    })(), TOTAL_TIMEOUT_MS, "timeout");
  } catch (error) {
    if (error?.message === "timeout") return { error: "The webpage took too long to load." };
    return { error: `Couldn't load that webpage${error?.code ? ` (${error.code})` : ""}.` };
  } finally {
    win.destroy();
    void ses.clearStorageData().catch(() => {});
  }
}

module.exports = { captureWebpage };
