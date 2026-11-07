import type { ScanLanguage } from "./scanLanguage";
import { AnnotationMode, OPS, type PDFPageProxy } from "pdfjs-dist";
import type { Worker as OcrWorker } from "tesseract.js";
import { startOcrWorker, MissingScanPack } from "./ocrWorker";
import { ocrSession } from "./lib/ocr/session/OcrSession";
import { toItems } from "./lib/ocr/text/words";
import { area, boxOf, dropDuplicates } from "./lib/ocr/text/geometry";
import { imageCover, isScanLike, SCAN_TEXT_COVER, textCover } from "./lib/ocr/text/scan";
import type { Box, TextItem } from "./lib/ocr/types";
import type { EventBus, PDFPageView, PDFViewer } from "./viewer";

const IMAGE_OPS = new Set<number>([
  OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintInlineImageXObjectGroup,
  OPS.paintImageMaskXObjectGroup, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat,
]);

async function hasPageImage(page: PDFPageProxy) {
  if (page.imageCoordinates?.length) return true;
  // pdf.js records locations for ordinary images but not for stencil masks used by some monochrome scans.
  const { fnArray } = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
  return fnArray.some(op => IMAGE_OPS.has(op));
}

async function readWords(page: PDFPageProxy, worker: OcrWorker, signal: AbortSignal): Promise<ReturnType<typeof toItems>> {
  signal.throwIfAborted();
  // Read at a consistent resolution even in fit-page mode. Bound both dimensions on oversized scans.
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, 2400 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const render = page.render({ canvas, viewport });
  const cancel = () => render.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await render.promise;
    signal.throwIfAborted();
    // A language switch or document close can terminate the worker during image encoding.
    // Encode here so we can check ownership before Tesseract posts its recognition job.
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error("Couldn't prepare the scan image."));
    }));
    signal.throwIfAborted();
    const bytes = new Uint8Array(await png.arrayBuffer());
    signal.throwIfAborted();
    const { data } = await worker.recognize(bytes, {}, { blocks: true, text: false });
    signal.throwIfAborted();
    const lines = (data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(p => p.lines));
    return toItems(lines, viewport);
  } finally {
    signal.removeEventListener("abort", cancel);
    canvas.width = canvas.height = 0;
  }
}

/** Retain only sparse native text; typed pages can be skipped without accumulating their entire text. */
async function sparseNativeText(page: PDFPageProxy, signal: AbortSignal): Promise<TextItem[] | null> {
  const reader = page.streamTextContent().getReader();
  const items: TextItem[] = [];
  let coverage = 0;
  let typed = false;
  const pageArea = area(page.view as Box);
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) return typed ? null : items;
      if (typed) continue;
      for (const item of value.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const text = item as TextItem;
        items.push(text);
        coverage += area(boxOf(text));
        if (pageArea > 0 && coverage / pageArea >= SCAN_TEXT_COVER) {
          items.length = 0;
          typed = true;
          break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Prepare the document sequentially, giving the reader's current page and its successor the next turns. */
export function recognizeScannedPages(bus: EventBus, viewer: PDFViewer, languages: ScanLanguage[], onStatus: (text: string | null) => void, onPhase: (phase: "running" | "done") => void) {
  const pdf = viewer.pdfDocument!;
  const controller = new AbortController();
  const { signal } = controller;
  const pending = new Set(Array.from({ length: pdf.numPages }, (_, i) => i + 1));
  const notices = new Map<number, "noWords" | "ocrError" | "layerError">();
  let nextPage = viewer.currentPageNumber;
  let active = 0;
  let recognizing = false;
  let timer: number | undefined;
  let worker: Promise<OcrWorker> | undefined;
  let workerStartFailed = false;
  let missingPackMessage: string | undefined;

  function updateStatus() {
    const n = viewer.currentPageNumber;
    const view: PDFPageView = viewer.getPageView(n - 1);
    const layer = view.textLayer?.div;
    if (notices.get(n) === "ocrError") onStatus(missingPackMessage ?? `Text unavailable on page ${n}.`);
    else if (layer?.isConnected && !layer.hidden && layer.textContent.trim()) onStatus(null);
    else if (notices.get(n) === "noWords") onStatus(`No readable text found on page ${n}.`);
    else if (notices.has(n)) onStatus(missingPackMessage ?? `Text unavailable on page ${n}.`);
    else if (active === n && recognizing) onStatus(`Recognizing text on page ${n}…`);
    else if (pending.has(n) || active === n || !layer?.isConnected || layer.hidden || !layer.querySelector(".endOfContent")) {
      onStatus(`Preparing text on page ${n}…`);
    } else onStatus(null);
  }

  function schedule() {
    if (!signal.aborted && !window.frameElement?.hasAttribute("inert") && !active && timer === undefined && pending.size) {
      timer = window.setTimeout(prepareNext, 0);
    }
  }

  async function prepareNext() {
    timer = undefined;
    if (!pending.size || signal.aborted || window.frameElement?.hasAttribute("inert")) return;
    // Start at the last jump, continue ahead of the reader, then wrap back to the beginning.
    while (!pending.has(nextPage)) nextPage = nextPage % pdf.numPages + 1;
    const n = nextPage;
    nextPage = n % pdf.numPages + 1;
    pending.delete(n);
    active = n;
    const view: PDFPageView = viewer.getPageView(n - 1);
    let page: PDFPageProxy | undefined;
    try {
      page = await pdf.getPage(n);
      signal.throwIfAborted();
      const session = ocrSession(pdf);
      if (session?.pages.has(n) || session?.embedded.has(n)) return;
      const native = await sparseNativeText(page, signal);
      if (!native) return;
      signal.throwIfAborted();
      if (!(await hasPageImage(page))) return;
      const scan = await isScanLike(native.length, textCover(native, page.view as Box), async () => {
        const { fnArray, argsArray } = await page!.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
        return imageCover(fnArray, argsArray, OPS, page!.view as Box);
      });
      if (!scan) return;
      signal.throwIfAborted();
      if (n !== viewer.currentPageNumber && pending.has(viewer.currentPageNumber)) {
        pending.add(n);
        return;
      }
      recognizing = true;
      if (n === viewer.currentPageNumber) updateStatus();
      worker ??= startOcrWorker(signal, languages).catch(error => { workerStartFailed = true; missingPackMessage = error instanceof MissingScanPack ? error.message : undefined; throw error; });
      const items = await readWords(page, await worker, signal);
      const newItems = dropDuplicates(items, native.map(boxOf));
      signal.throwIfAborted();
      if (newItems.length && session) {
        session.record(n, newItems);
        // Rebuild through pdf.js so its text spans and find-highlighter map stay in sync.
        if (view.renderingState !== 0) {
          view.reset({ keepAnnotationLayer: true, keepAnnotationEditorLayer: true, keepCanvasWrapper: true });
          viewer.update();
        }
      } else {
        notices.set(n, "noWords");
      }
    } catch (error) {
      if (!signal.aborted) {
        notices.set(n, "ocrError");
        console.warn("Page OCR failed", error);
      }
    } finally {
      active = 0;
      recognizing = false;
      if (!signal.aborted) {
        // Background renders aren't in the viewer's page buffer, so it won't release their images for us.
        if (!viewer.getCachedPageViews().has(view)) page?.cleanup();
        if (n === viewer.currentPageNumber) updateStatus();
        if (!pending.size) onPhase("done");
        schedule();
      }
    }
  }

  bus.on("textlayerrendered", ({ source: view, pageNumber: n, error }: { source: PDFPageView; pageNumber: number; error: unknown }) => {
    if (error) {
      notices.set(n, "layerError");
      if (n === viewer.currentPageNumber) updateStatus();
      return;
    }
    if (notices.get(n) === "layerError") notices.delete(n);
    if (ocrSession(pdf)?.pages.has(n)) view.textLayer?.div.classList.add("ocr-text");
    if (n === viewer.currentPageNumber) updateStatus();
    schedule();
  }, { signal });
  bus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
    nextPage = pageNumber;
    if (notices.get(pageNumber) === "ocrError") {
      notices.delete(pageNumber);
      if (workerStartFailed) { worker = undefined; workerStartFailed = false; }
      if (pageNumber !== active) pending.add(pageNumber);
    }
    updateStatus();
    schedule();
  }, { signal });
  window.addEventListener("folio:tab-visibility", schedule, { signal });
  const stop = () => {
    controller.abort();
    window.clearTimeout(timer);
    pending.clear();
    onStatus(null);
    void worker?.then(w => w.terminate()).catch(() => {});
  };
  onPhase("running");
  updateStatus();
  schedule();
  return {
    stop,
    retry() {
      if (signal.aborted) return;
      if (workerStartFailed) { worker = undefined; workerStartFailed = false; }
      for (let n = 1; n <= pdf.numPages; n++) {
        if (n !== active && !ocrSession(pdf)?.pages.has(n) && !ocrSession(pdf)?.embedded.has(n)) pending.add(n);
        if (notices.get(n) === "ocrError") notices.delete(n);
      }
      nextPage = viewer.currentPageNumber;
      if (pending.size || active) onPhase("running");
      updateStatus();
      schedule();
    },
  };
}
