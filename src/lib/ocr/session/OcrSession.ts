// Text recognition (OCR) for scanned PDFs. Tesseract runs in a worker, fully offline (its runtime is bundled
// under public/ocr, see scripts/copy-pdfjs-assets.mjs). Recognized words are handed back to pdf.js as if they
// were the page's own text, so selection, search, highlights, and Ask AI work on scans without special cases.
// The geometry, filtering, and scan detection live in ../text.
import { pdfjs, type PDFDocumentProxy } from "../../../pdf";
import { PAGES_KEY, parsePages } from "../export/pageList";
import { getOcrPages, saveOcrPage } from "../storage/ocrStore";
import { boxOf, dropDuplicates } from "../text/geometry";
import { nearestUnqueued, withRecognized } from "../text/pages";
import { imageCover, isScanLike, textCover } from "../text/scan";
import { STYLES, toItems, type Line } from "../text/words";
import type { Box, OcrState, TextItem } from "../types";

type Page = Awaited<ReturnType<PDFDocumentProxy["getPage"]>>;
type Worker = { terminate(): Promise<unknown> };

// Pages are drawn at 300 dpi, but no side longer than 3,300 px: Letter is read at 300 dpi, A4 at about 282, A3 at about
// 200, and an A1 sheet at about 100. A bigger picture costs memory and time out of proportion. On a synthetic A1
// drawing sheet (known words in 2.5 to 10 mm lettering, read with the shipped model) it did not pay: reading at 200 dpi
// found 84% of the words against 85% at 100 dpi, and reading the sheet in 300 dpi tiles found 85% in three times the
// time, so large sheets stay one capped picture. An earlier trial on real drawing sheets agreed: a higher cap read a
// large sheet only slightly better, and an A4 page slightly worse.
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
  /** Pages whose recognized text is already inside the PDF itself, because it is a copy that Folio saved. */
  readonly embedded = new Set<number>();
  /** Bumped whenever a page gains text, so caches built from page text know to refresh. */
  version = 0;
  state: OcrState = { phase: "idle", done: 0, total: 0 };
  #key: string | null;
  #listeners = new Set<() => void>();
  #pageListeners = new Set<(page: number) => void>();
  #destroyed = false;
  /** Bumped by cancel() and destroy(): a run belongs to the number it started with and stops when that is no longer current. */
  #generation = 0;
  /** The workers of the current run. Each run stops only its own, so an old run can't take down a new one's. */
  #workers: Worker[] = [];

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
    await this.#readEmbedded();
    if (!this.#key) return;
    for (const [page, items] of await getOcrPages(this.#key)) this.pages.set(page, items);
    if (this.pages.size) this.version++;
  }

  /** A copy saved by Folio lists, in its document info, the pages it carries recognized text for. */
  async #readEmbedded() {
    try {
      const { info } = await this.pdf.getMetadata();
      // pdf.js hands the info's own (non-standard) entries over as a Map.
      const list = (info as { Custom?: Map<string, unknown> }).Custom?.get(PAGES_KEY);
      if (typeof list === "string") for (const n of parsePages(list, this.pdf.numPages)) this.embedded.add(n);
    } catch {
      /* no readable document info: nothing was embedded */
    }
  }

  /** Pages that have recognized text, whether kept alongside the document or inside it. */
  #recognized() {
    return new Set([...this.pages.keys(), ...this.embedded]);
  }

  /** Looks at a few pages; if most carry no text, this is a scan and recognition is offered. */
  async detect() {
    const total = this.pdf.numPages;
    const sample = [...new Set([1, 2, 3, 4, 5, 6].map((i) => Math.max(1, Math.round((i * total) / 6))))];
    let empty = 0;
    for (const n of sample) {
      if (this.#recognized().has(n) || (await looksScanned(await this.pdf.getPage(n)))) empty++;
    }
    if (this.#destroyed || empty * 2 < sample.length) return;
    const recognized = this.#recognized().size;
    const finished = recognized >= total;
    this.#set({ phase: finished ? "done" : "offer", total, done: finished ? total : recognized });
  }

  /** Recognizes every page that has no text, starting near the page being read. */
  async start(focus: () => number) {
    if (this.state.phase === "running") return;
    const run = ++this.#generation;
    const live = () => run === this.#generation;
    const mine: Worker[] = [];
    this.#workers = mine;
    const total = this.pdf.numPages;
    const queued = this.#recognized();
    this.#set({ phase: "running", total, done: queued.size, error: undefined });
    const next = () => {
      const best = nearestUnqueued(total, queued, focus());
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
        mine.push(worker);
        return worker;
      }));
      if (!live()) return;
      // Pages that already have text are skipped, so only the pages sent to the recognizer count towards failing.
      let sent = 0, failures = 0;
      await Promise.all(workers.map(async (worker) => {
        for (let n = next(); n && live(); n = next()) {
          try { if (await this.#recognize(worker, n, live)) sent++; } catch { sent++; if (live()) failures++; }
          if (live()) this.#set({ done: this.state.done + 1 });
        }
      }));
      if (!live()) return;
      this.#set(failures === 0 ? { phase: "done", done: total }
        : { phase: "error", done: total, error: failures === sent ? "Couldn't read this document's pages." : `Couldn't read ${failures} of ${sent} scanned pages.` });
    } catch {
      if (live()) this.#set({ phase: "error", error: "Couldn't start text recognition." });
    } finally {
      await this.#stop(mine);
    }
  }

  async #recognize(worker: { recognize(image: HTMLCanvasElement, options: object, output: object): Promise<{ data: { blocks: { paragraphs: { lines: Line[] }[] }[] | null } }> }, n: number, live: () => boolean) {
    const page = await this.pdf.getPage(n);
    // Pages that already have text (mixed documents) are left alone.
    if (this.pages.has(n) || !(await looksScanned(page))) return false;
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
      if (!live()) return true;
      const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
      const items = dropDuplicates(toItems(lines, viewport), embeddedBoxes);
      // Pages with nothing new are remembered too (as empty), so they aren't read again next time.
      this.pages.set(n, items);
      if (this.#key) void saveOcrPage(this.#key, n, items);
      if (!items.length) return true;
      this.version++;
      for (const listener of this.#pageListeners) listener(n);
      return true;
    } finally {
      canvas.width = canvas.height = 0; // frees the pixels now rather than at the next garbage collection
      page.cleanup();
    }
  }

  async #stop(workers: Worker[]) {
    await Promise.all(workers.splice(0).map((w) => w.terminate().catch(() => {})));
  }

  /** Stops recognition; pages already done keep their text. */
  cancel() {
    this.#generation++;
    if (this.state.phase === "running") this.#set({ phase: "offer" });
    void this.#stop(this.#workers);
  }

  dismiss() {
    this.#set({ phase: "idle" });
  }

  destroy() {
    this.#destroyed = true;
    this.#generation++;
    void this.#stop(this.#workers);
    this.#listeners.clear();
    this.#pageListeners.clear();
  }
}
