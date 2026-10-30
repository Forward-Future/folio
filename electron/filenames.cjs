// File names for PDFs that arrive from the web: a download's name, or a captured page's title.

// Windows can't create files named after devices — "CON.pdf" included — so a server- or
// page-supplied name needs that case broken too, not just the illegal characters.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** `name` with everything a file system refuses taken out, ending in .pdf; `fallback` when nothing is left. */
function safePdfName(name, fallback) {
  const clean = String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || fallback;
  const stem = clean.replace(/\.pdf$/i, "");
  const safe = WINDOWS_DEVICE_NAME.test(stem) ? stem + "_" : clean;
  return /\.pdf$/i.test(safe) ? safe : safe + ".pdf";
}

module.exports = { safePdfName };
