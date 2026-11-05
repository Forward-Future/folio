const { randomUUID } = require("node:crypto");

function validatePrintJob(job) {
  if (!job || !["Letter", "A4", "Legal"].includes(job.paper) || ![150, 300, 600].includes(job.dpi) || typeof job.landscape !== "boolean"
    || typeof job.booklet !== "boolean" || !Number.isInteger(job.copies) || job.copies < 1 || job.copies > 999
    || typeof job.printer !== "string" || job.printer.length > 512
    || !Array.isArray(job.images) || !job.images.length || job.images.length > 100) throw new Error("Invalid print settings.");
  const paper = { Letter: [612, 792], A4: [595.28, 841.89], Legal: [612, 1008] }[job.paper];
  const dimensions = (job.landscape ? [...paper].reverse() : paper).map(points => Math.ceil(points * job.dpi / 72));
  // Match renderer allocation checks; validate dimensions before Chromium decodes any images.
  if (dimensions[0] * dimensions[1] > 48_000_000 || dimensions[0] * dimensions[1] * 4 * job.images.length > 576 * 1024 * 1024) {
    throw new Error("Decoded print images exceed the memory limit. Select fewer pages, reduce poster scale/overlap, or choose a lower DPI.");
  }
  let bytes = 0;
  for (const image of job.images) {
    if (typeof image !== "string" || image.length > 64 * 1024 * 1024 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new Error("Invalid print image or image above 64 MiB. Choose a lower DPI.");
    const header = Buffer.from(image.slice(22, 70), "base64");
    if (header.length < 33 || header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || header.readUInt32BE(8) !== 13
      || header.toString("ascii", 12, 16) !== "IHDR" || header.readUInt32BE(16) !== dimensions[0] || header.readUInt32BE(20) !== dimensions[1]) throw new Error("Print image dimensions do not match the selected DPI and paper size.");
    bytes += image.length;
    if (bytes > 64 * 1024 * 1024) throw new Error("Print job exceeds 64 MB. Select fewer pages.");
  }
}

function printHtml(job) {
  validatePrintJob(job);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Folio print</title><style>
    @page { size: ${job.paper} ${job.landscape ? "landscape" : "portrait"}; margin: 0; }
    * { box-sizing: border-box; } html, body { margin: 0; padding: 0; }
    .sheet { width: 100vw; height: 100vh; break-after: page; overflow: hidden; }
    .sheet:last-child { break-after: auto; } img { display: block; width: 100%; height: 100%; object-fit: fill; }
    </style></head><body>${job.images.map(image => `<div class="sheet"><img src="${image}"></div>`).join("")}</body></html>`;
}

function registerPrinting(handle, getOwner) {
  const { BrowserWindow } = require("electron");
  let printing = false;
  handle("folio:printers", async () => (await getOwner().webContents.getPrintersAsync()).map(p => ({ name: p.name, displayName: p.displayName, isDefault: p.isDefault })));
  handle("folio:print-sheets", async (_event, job) => {
    if (printing) return { ok: false, error: "Another print dialog is already open." };
    validatePrintJob(job);
    printing = true;
    let printWindow;
    try {
      const owner = getOwner();
      if (job.printer && !(await owner.webContents.getPrintersAsync()).some(p => p.name === job.printer)) throw new Error("The selected printer is no longer available.");
      printWindow = new BrowserWindow({ show: false, parent: owner, width: 800, height: 1000,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `folio-print-${randomUUID()}` } });
      printWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      printWindow.webContents.on("will-navigate", event => event.preventDefault());
      printWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      // Large high-DPI jobs exceed Chromium's URL length limit. Serve the in-memory
      // document through this window's private session, without encoding it into the URL.
      const printSession = printWindow.webContents.session;
      printSession.protocol.handle("folio-print", request => request.url === "folio-print://job/index.html"
        ? new Response(printHtml(job), { headers: { "Content-Type": "text/html; charset=utf-8" } })
        : new Response("Not found", { status: 404 }));
      try { await printWindow.loadURL("folio-print://job/index.html"); }
      finally { printSession.protocol.unhandle("folio-print"); }
      await printWindow.webContents.executeJavaScript("Promise.all([...document.images].map(image => image.decode()))");
      return await new Promise(resolve => {
        printWindow.webContents.print({ silent: false, printBackground: true, deviceName: job.printer,
          copies: job.copies, collate: true, pageSize: job.paper, landscape: job.landscape, dpi: { horizontal: job.dpi, vertical: job.dpi },
          margins: { marginType: "none" }, scaleFactor: 100, pagesPerSheet: 1,
          duplexMode: job.booklet ? (job.landscape ? "shortEdge" : "longEdge") : "simplex" },
        (ok, error) => resolve({ ok, error: ok ? undefined : error || "Printing cancelled or failed." }));
      });
    } catch (error) { return { ok: false, error: error.message }; }
    finally { if (printWindow && !printWindow.isDestroyed()) printWindow.destroy(); printing = false; }
  });
}

module.exports = { registerPrinting, validatePrintJob, printHtml };
