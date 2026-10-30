import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { paintImageOverlay } from "./nightImages";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const base = `${import.meta.env.BASE_URL}pdfjs/`;

export type { PDFDocumentProxy };

export function loadPdf(data: Uint8Array, password?: string) {
  return pdfjs.getDocument({
    // pdf.js transfers the buffer to the worker, so hand it a copy and keep ours for saving/printing.
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
