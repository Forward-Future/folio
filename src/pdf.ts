import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { paintImageOverlay } from "./nightImages";
import { checkPageCount, checkPdfSize } from "./pdfInput";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const base = `${import.meta.env.BASE_URL}pdfjs/`;

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

/** Writes every original page once, in the order shown in the organizer. */
export async function reorderPdf(pdf: PDFDocumentProxy, order: number[], signal: AbortSignal, password?: string) {
  // pdf.js takes each source page's destination index, the inverse of the thumbnail list.
  const pageIndices: number[] = [];
  order.forEach((source, index) => { pageIndices[source - 1] = index; });
  // Extraction alone doesn't commit form values. Reorder a saved snapshot when there are edits.
  const snapshot = pdf.annotationStorage.size ? await loadPdf(await pdf.saveDocument(), signal, password) : pdf;
  try {
    const bytes = await snapshot.extractPages([{ document: null, pageIndices }]);
    if (!bytes?.length) throw new Error("Page reordering failed.");
    return bytes;
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
