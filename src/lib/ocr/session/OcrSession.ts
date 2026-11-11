// Stores and exposes the reader’s recognized text for search, AI, and searchable PDF copies.
import type { PDFDocumentProxy } from "../../../pdf";
import { PAGES_KEY, parsePages } from "../export/pageList";
import { ocrEpoch } from "../../../recent";
import type { ScanLanguage } from "../../../scanLanguage";
import { getOcrPages, saveOcrPage, ocrLanguageKey } from "../storage/ocrStore";
import { withRecognized } from "../text/pages";
import { STYLES } from "../text/words";

const sessions = new WeakMap<PDFDocumentProxy, OcrSession>();
export const ocrSession = (pdf: PDFDocumentProxy) => sessions.get(pdf);

export class OcrSession {
  readonly pdf: PDFDocumentProxy;
  /** Pages with recognized text, by page number. */
  readonly pages = new Map<number, unknown[]>();
  /** Pages whose recognized text is already inside the PDF itself, because it is a copy that Folio saved. */
  readonly embedded = new Set<number>();
  /** Bumped whenever a page gains text, so caches built from page text know to refresh. */
  version = 0;
  #key: string | null;
  #epoch: string | null;
  #pageListeners = new Set<(page: number) => void>();
  #destroyed = false;
  #languages: ScanLanguage[];
  #generation = 0;
  /** `key` is the document's content id; without one (password-protected files) results stay in memory only. */
  constructor(pdf: PDFDocumentProxy, key: string | null, languages: ScanLanguage[] = ["eng"]) {
    this.pdf = pdf;
    this.#languages = [...languages];
    this.#key = key;
    this.#epoch = key ? ocrEpoch(key) : "";
    sessions.set(pdf, this);
    // Install the override before the viewer asks for any page.
    const getPage = pdf.getPage.bind(pdf);
    const patched = new WeakSet<object>();
    pdf.getPage = async (n: number) => {
      const page = await getPage(n);
      if (!patched.has(page)) {
        patched.add(page);
        const original = page.streamTextContent.bind(page) as () => ReadableStream;
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

  onPage(listener: (page: number) => void) {
    this.#pageListeners.add(listener);
    return () => { this.#pageListeners.delete(listener); };
  }

  /** Save the result of the reader's single OCR pass for search and export. */
  record(page: number, items: unknown[]) {
    if (this.#destroyed || !items.length || this.pages.has(page) || this.embedded.has(page)) return;
    this.pages.set(page, items);
    if (this.#key) void saveOcrPage(this.#key, page, items, this.#epoch, this.#languages);
    this.version++;
    for (const listener of this.#pageListeners) listener(page);
  }

  /** Brings back pages recognized in an earlier session. Call before the document is shown. */
  async restore() {
    const generation = this.#generation;
    await this.#readEmbedded();
    if (this.#destroyed || generation !== this.#generation) return;
    await this.#restorePages(generation);
  }

  /** Stop the old recognizer before changing languages; it must not record into the new selection. */
  async setLanguages(languages: ScanLanguage[]) {
    if (this.#destroyed || ocrLanguageKey(languages) === ocrLanguageKey(this.#languages)) return;
    this.#languages = [...languages];
    const generation = ++this.#generation;
    const removed = [...this.pages.keys()];
    this.pages.clear();
    this.version++;
    for (const page of removed) for (const listener of this.#pageListeners) listener(page);
    await this.#restorePages(generation);
  }

  async #restorePages(generation: number) {
    if (!this.#key) return;
    const pages = await getOcrPages(this.#key, this.#languages);
    if (this.#destroyed || generation !== this.#generation || this.#epoch !== ocrEpoch(this.#key)) return;
    const restored: number[] = [];
    for (const [page, items] of pages) {
      if (items.length && page >= 1 && page <= this.pdf.numPages && !this.embedded.has(page) && !this.pages.has(page)) {
        this.pages.set(page, items);
        restored.push(page);
      }
    }
    if (restored.length) {
      this.version++;
      for (const page of restored) for (const listener of this.#pageListeners) listener(page);
    }
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

  destroy() {
    this.#destroyed = true;
    this.#pageListeners.clear();
    sessions.delete(this.pdf);
  }
}
