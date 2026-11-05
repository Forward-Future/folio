import type { PDFDocumentProxy } from "./pdf";
import { MAX_PRINT_PIXELS, printPixels, type PrintSettings, type PrintSheet } from "./printLayout";

export async function renderPrintSheet(pdf: PDFDocumentProxy, sheet: PrintSheet, settings: PrintSettings,
  dpi: number, signal: AbortSignal, jobLandscape?: boolean): Promise<HTMLCanvasElement> {
  signal.throwIfAborted();
  const pixels = printPixels(sheet, dpi);
  if (!(dpi > 0) || !Number.isFinite(pixels.width * pixels.height) || pixels.width * pixels.height > MAX_PRINT_PIXELS) {
    throw new Error("This sheet exceeds the 48-megapixel limit. Choose a lower DPI or smaller paper.");
  }
  const canvas = document.createElement("canvas");
  const factor = dpi / 72;
  // Native print jobs have one paper orientation. Turn only the differently oriented sheets
  // for the driver; the preview still shows each one the way the reader holds it.
  const rotate = jobLandscape !== undefined && jobLandscape !== (sheet.width > sheet.height);
  canvas.width = rotate ? pixels.height : pixels.width;
  canvas.height = rotate ? pixels.width : pixels.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) { canvas.width = canvas.height = 0; throw new Error("Couldn't allocate the print sheet. Close other documents or choose a lower DPI."); }
  try {
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (rotate) { ctx.translate(canvas.width, 0); ctx.rotate(Math.PI / 2); }
    for (const item of sheet.placements) {
      signal.throwIfAborted();
      const page = await pdf.getPage(item.page);
      signal.throwIfAborted();
      // Render at the requested scale into only the visible tile/cell, without a source resolution cap.
      const viewport = page.getViewport({ scale: item.scale * factor });
      const left = Math.max(0, Math.floor(item.clip.x * factor));
      const top = Math.max(0, Math.floor(item.clip.y * factor));
      const right = Math.min(pixels.width, Math.ceil((item.clip.x + item.clip.width) * factor));
      const bottom = Math.min(pixels.height, Math.ceil((item.clip.y + item.clip.height) * factor));
      const source = document.createElement("canvas");
      source.width = right - left; source.height = bottom - top;
      try {
        const task = page.render({ canvas: source, viewport, intent: "print",
          transform: [1, 0, 0, 1, item.x * factor - left, item.y * factor - top] });
        const cancel = () => task.cancel();
        signal.addEventListener("abort", cancel, { once: true });
        try { await task.promise; signal.throwIfAborted(); }
        finally { signal.removeEventListener("abort", cancel); }
        ctx.save();
        ctx.beginPath(); ctx.rect(item.clip.x * factor, item.clip.y * factor, item.clip.width * factor, item.clip.height * factor); ctx.clip();
        ctx.filter = settings.grayscale ? "grayscale(1)" : "none";
        ctx.globalAlpha = settings.toner ? 0.7 : 1;
        ctx.drawImage(source, left, top);
        ctx.restore();
      } finally { source.width = source.height = 0; }
    }
    return canvas;
  } catch (error) { canvas.width = canvas.height = 0; throw error; }
}

// Asynchronous encoding lets Cancel run while a large sheet is being compressed.
export async function encodePrintSheet(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Couldn't encode this sheet. Choose a lower DPI.")), "image/png"));
  signal.throwIfAborted();
  if (Math.ceil(blob.size / 3) * 4 + 22 > 64 * 1024 * 1024) throw new Error("This sheet exceeds 64 MiB of encoded data. Choose a lower DPI.");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    const cleanup = () => signal.removeEventListener("abort", abort);
    reader.onload = () => { cleanup(); try { signal.throwIfAborted(); resolve(reader.result as string); } catch (e) { reject(e); } };
    reader.onerror = () => { cleanup(); reject(new Error("Couldn't encode the print sheet.")); };
    reader.onabort = () => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    reader.readAsDataURL(blob);
  });
}
