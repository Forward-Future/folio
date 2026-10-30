// Text recognition (OCR) for scanned PDFs. Tesseract runs in a worker, fully offline (its runtime is bundled
// under public/ocr, see scripts/copy-pdfjs-assets.mjs). Recognized words are handed back to pdf.js as if they
// were the page's own text, so selection, search, highlights, and Ask AI work on scans without special cases.
// The geometry, filtering, and scan detection live in ../text.
import { pdfjs, type PDFDocumentProxy } from "../../../pdf";
import { getOcrPages, saveOcrPage } from "../storage/ocrStore";
import { boxOf, dropDuplicates } from "../text/geometry";
import { nearestUnqueued, withRecognized } from "../text/pages";
import { imageCover, isScanLike, textCover } from "../text/scan";
import { STYLES, toItems, type Line } from "../text/words";
import type { Box, OcrState, TextItem } from "../types";

type Page = Awaited<ReturnType<PDFDocumentProxy["getPage"]>>;

const OCR_DPI = 300;
const MAX_EDGE_PX = 3300;
const MAX_WORKERS = 2;

const sessions = new WeakMap<PDFDocumentProxy, OcrSession>();
const rawStreams = new WeakMap<object, () => ReadableStream>();

export const ocrSession = (pdf: PDFDocumentProxy) => sessions.get(pdf);

/** What the PDF itself carries for a page, ignoring anything recognized. */
async function embeddedText(page: Page) {
  const reader = rawStreams.get(page)!().getReader();
  const items: TextItem[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const item of value.items as TextItem[]) if (item.str?.trim()) items.push(item);
  }
  return { items, share: textCover(items, page.view as Box) };
}

async function looksScanned(page: Page) {
  const { items, share } = await embeddedText(page);
  return isScanLike(items.length, share, async () => {
    const { fnArray, argsArray } = await page.getOperatorList();
    return imageCover(fnArray, argsArray, pdfjs.OPS, page.view as Box);
  });
}

export class OcrSession {
  readonly pdf: PDFDocumentProxy;
  /** Pages with recognized text, by page number. */
  readonly pages = new Map<number, unknown[]>();
  /** Bumped whenever a page gains text, so caches built from page text know to refresh. */
  version = 0;
  state: OcrState = { phase: "idle", done: 0, total: 0 };
  #key: string | null;
  #listeners = new Set<() => void>();
  #pageListeners = new Set<(page: number) => void>();
  #cancelled = false;
  #workers: { terminate(): Promise<unknown> }[] = [];
  #focus: () => number = () => 1;

  /** `key` is the document's content id; without one (password-protected files) results stay in memory only. */
  constructor(pdf: PDFDocumentProxy, key: string | null) {
    this.pdf = pdf;
    this.#key = key;
    sessions.set(pdf, this);
    // Install the override before the viewer asks for any page.
    const getPage = pdf.getPage.bind(pdf);
    const patched = new WeakSet<object>();
    pdf.getPage = async (n: number) => {
      const page = await getPage(n);
      if (!patched.has(page)) {
        patched.add(page);
        const original = page.streamTextContent.bind(page) as () => ReadableStream;
        rawStreams.set(page, original);
        page.streamTextContent = ((params?: object) => {
          const items = this.pages.get(n);
          const source = (original as (p?: object) => ReadableStream)(params);
          // The PDF's own text (a stamp, a header) stays; recognized words follow it.
          return items?.length ? withRecognized(source, items, STYLES) : source;
        }) as typeof page.streamTextContent;
      }
      return page;
    };
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };
  onPage(listener: (page: number) => void) {
    this.#pageListeners.add(listener);
    return () => { this.#pageListeners.delete(listener); };
  }

  #set(state: Partial<OcrState>) {
    this.state = { ...this.state, ...state };
    for (const listener of this.#listeners) listener();
  }

  /** Brings back pages recognized in an earlier session. Call before the document is shown. */
  async restore() {
    if (!this.#key) return;
    for (const [page, items] of await getOcrPages(this.#key)) this.pages.set(page, items);
    if (this.pages.size) this.version++;
  }

  /** Looks at a few pages; if most carry no text, this is a scan and recognition is offered. */
  async detect() {
    const total = this.pdf.numPages;
    const sample = [...new Set([1, 2, 3, 4, 5, 6].map((i) => Math.max(1, Math.round((i * total) / 6))))];
    let empty = 0;
    for (const n of sample) {
      if (this.pages.has(n) || (await looksScanned(await this.pdf.getPage(n)))) empty++;
    }
    if (this.#cancelled || empty * 2 < sample.length) return;
    const finished = this.pages.size >= total;
    this.#set({ phase: finished ? "done" : "offer", total, done: finished ? total : this.pages.size });
  }

  /** Recognizes every page that has no text, starting near the page being read. */
  async start(focus: () => number) {
    if (this.state.phase === "running") return;
    this.#focus = focus;
    this.#cancelled = false;
    const total = this.pdf.numPages;
    const queued = new Set<number>(this.pages.keys());
    this.#set({ phase: "running", total, done: queued.size, error: undefined });
    const next = () => {
      const best = nearestUnqueued(total, queued, this.#focus());
      if (best) queued.add(best);
      return best;
    };
    try {
      const { createWorker } = await import("tesseract.js");
      const base = new URL(`${import.meta.env.BASE_URL}ocr/`, location.href).href;
      const count = Math.max(1, Math.min(MAX_WORKERS, Math.floor((navigator.hardwareConcurrency || 2) / 4)));
      const workers = await Promise.all(Array.from({ length: count }, async () => {
        const worker = await createWorker("eng", 1 /* LSTM only: the bundled model has no legacy data */, {
          workerPath: base + "worker.min.js", corePath: base + "core", langPath: base + "lang",
          // Start the worker straight from the app's own file rather than through a blob: wrapper, and skip
          // the browser cache: the model is a local file, not a download.
          workerBlobURL: false, cacheMethod: "none", gzip: true,
        });
        this.#workers.push(worker);
        return worker;
      }));
      if (this.#cancelled) return;
      let failures = 0;
      await Promise.all(workers.map(async (worker) => {
        for (let n = next(); n && !this.#cancelled; n = next()) {
          try { await this.#recognize(worker, n); } catch { if (!this.#cancelled) failures++; }
          if (!this.#cancelled) this.#set({ done: this.state.done + 1 });
        }
      }));
      if (this.#cancelled) return;
      this.#set(failures === total
        ? { phase: "error", error: "Couldn't read this document's pages." }
        : { phase: "done", done: total });
    } catch {
      if (!this.#cancelled) this.#set({ phase: "error", error: "Couldn't start text recognition." });
    } finally {
      await this.#stopWorkers();
    }
  }

  async #recognize(worker: { recognize(image: HTMLCanvasElement, options: object, output: object): Promise<{ data: { blocks: { paragraphs: { lines: Line[] }[] }[] | null } }> }, n: number) {
    const page = await this.pdf.getPage(n);
    // Pages that already have text (mixed documents) are left alone.
    if (this.pages.has(n) || !(await looksScanned(page))) return;
    const embeddedBoxes = (await embeddedText(page)).items.map(boxOf);
    const natural = page.getViewport({ scale: 1 });
    const scale = Math.min(OCR_DPI / 72, MAX_EDGE_PX / Math.max(natural.width, natural.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    try {
      await page.render({ canvas, viewport, background: "#ffffff" }).promise;
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      if (this.#cancelled) return;
      const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
      const items = dropDuplicates(toItems(lines, viewport), embeddedBoxes);
      // Pages with nothing new are remembered too (as empty), so they aren't read again next time.
      this.pages.set(n, items);
      if (this.#key) void saveOcrPage(this.#key, n, items);
      if (!items.length) return;
      this.version++;
      for (const listener of this.#pageListeners) listener(n);
    } finally {
      canvas.width = canvas.height = 0; // frees the pixels now rather than at the next garbage collection
      page.cleanup();
    }
  }

  async #stopWorkers() {
    const workers = this.#workers.splice(0);
    await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  }

  /** Stops recognition; pages already done keep their text. */
  cancel() {
    this.#cancelled = true;
    if (this.state.phase === "running") this.#set({ phase: "offer" });
    void this.#stopWorkers();
  }

  dismiss() {
    this.#set({ phase: "idle" });
  }

  destroy() {
    this.#cancelled = true;
    void this.#stopWorkers();
    this.#listeners.clear();
    this.#pageListeners.clear();
  }
}
