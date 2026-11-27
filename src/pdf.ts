import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { paintImageOverlay } from "./nightImages";
import type { DraftPage } from "./organize";
import type { EditorReply } from "./contentEditor.worker";
import { checkPageCount, checkPdfSize } from "./pdfInput";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const base = `${import.meta.env.BASE_URL}pdfjs/`;

export { pdfjs };
export type { PDFDocumentProxy };

export async function loadPdf(data: Uint8Array, signal: AbortSignal, password?: string) {
  checkPdfSize(data.byteLength);
  signal.throwIfAborted();
  const task = pdfjs.getDocument({
    // pdf.js transfers this buffer to the worker. Folio still needs the input for identity, Recent and password retries.
    data: data.slice(),
    password,
    // PDFs are untrusted: don't render XFA forms (embedded PDF JavaScript is never run; no scripting manager).
    enableXfa: false,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
  });
  const abort = () => { void task.destroy().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const pdf = await task.promise;
    signal.throwIfAborted();
    checkPageCount(pdf.numPages);
    return pdf;
  } catch (error) {
    if (!signal.aborted) await task.destroy().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function isEncrypted(pdf: PDFDocumentProxy) {
  const { info } = await pdf.getMetadata();
  return !!(info as { EncryptFilterName?: string }).EncryptFilterName;
}

/** Writes the requested one-based pages into a new PDF, in the supplied order. */
export async function copyPdfPages(pdf: PDFDocumentProxy, pages: DraftPage[], signal: AbortSignal, password?: string) {
  const groups = new Map<PDFDocumentProxy, { source: number; destination: number }[]>();
  for (const [destination, page] of pages.entries()) {
    const source = page.source?.pdf ?? pdf;
    let group = groups.get(source);
    if (!group) groups.set(source, group = []);
    group.push({ source: page.page - 1, destination });
  }
  if (pages.some(page => page.source) && await isEncrypted(pdf)) throw new Error("Cannot insert pages into a protected PDF.");
  const entries = [];
  for (const [source, group] of groups) {
    // pdf.js extracts each file in source order. Destination indices put interleaved pages back in draft order.
    group.sort((a, b) => a.source - b.source);
    entries.push({ document: source === pdf ? null : await source.getData(),
      includePages: group.map(item => item.source), pageIndices: group.map(item => item.destination) });
  }
  signal.throwIfAborted();
  // Extraction alone doesn't commit form values. Use a saved snapshot when there are edits.
  const snapshot = pdf.annotationStorage.size ? await loadPdf(await pdf.saveDocument(), signal, password) : pdf;
  try {
    const bytes = await snapshot.extractPages(entries);
    if (!bytes?.length) throw new Error("Couldn't copy the selected pages.");
    checkPdfSize(bytes.byteLength);
    if (!pages.some(p => p.rotation)) return bytes;
    const worker = new Worker(new URL("./contentEditor.worker.ts", import.meta.url), { type: "module" });
    try {
      signal.throwIfAborted();
      return await new Promise<Uint8Array>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        worker.onmessage = ({ data }: MessageEvent<EditorReply>) => {
          signal.removeEventListener("abort", abort);
          if ("bytes" in data) resolve(data.bytes);
          else reject(new Error("error" in data ? data.error : "Couldn't rotate these pages."));
        };
        worker.onerror = event => {
          signal.removeEventListener("abort", abort);
          reject(new Error(event.message));
        };
        worker.postMessage({ snapshot: bytes, rotations: pages.map(p => p.rotation ?? 0), password }, [bytes.buffer]);
      });
    } finally { worker.terminate(); }
  } finally {
    if (snapshot !== pdf) await snapshot.loadingTask.destroy();
  }
}

/** Renders a page into a canvas sized to `width` CSS pixels. */
export async function renderThumbnail(
  doc: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  width: number,
  rotation = 0,
  signal?: AbortSignal,
) {
  const page = await doc.getPage(pageNumber);
  signal?.throwIfAborted();
  const base = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({
    scale: (width / base.width) * dpr,
    rotation: (page.rotate + rotation) % 360,
  });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${(viewport.height / viewport.width) * width}px`;
  const task = page.render({ canvas, viewport, recordImages: true });
  const cancel = () => task.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await task.promise;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  if (canvas.parentElement) paintImageOverlay(canvas.parentElement, canvas, page, viewport.rotation);
}

export async function thumbnailDataUrl(doc: PDFDocumentProxy) {
  const canvas = document.createElement("canvas");
  await renderThumbnail(doc, 1, canvas, 220);
  return canvas.toDataURL("image/jpeg", 0.8);
}

export interface OutlineItem {
  title: string;
  dest: string | unknown[] | null;
  url: string | null;
  items: OutlineItem[];
}
