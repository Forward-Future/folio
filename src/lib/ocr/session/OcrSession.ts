// Stores and exposes the reader’s recognized text for search, AI, and searchable PDF copies.
import type { PDFDocumentProxy } from "../../../pdf";
import { PAGES_KEY, parsePages } from "../export/pageList";
import { ocrEpoch } from "../../../recent";
import { getOcrPages, saveOcrPage } from "../storage/ocrStore";
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
  /** `key` is the document's content id; without one (password-protected files) results stay in memory only. */
  constructor(pdf: PDFDocumentProxy, key: string | null) {
    this.pdf = pdf;
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
    if (this.#key) void saveOcrPage(this.#key, page, items, this.#epoch);
    this.version++;
    for (const listener of this.#pageListeners) listener(page);
  }

  /** Brings back pages recognized in an earlier session. Call before the document is shown. */
  async restore() {
    await this.#readEmbedded();
    if (!this.#key) return;
    for (const [page, items] of await getOcrPages(this.#key)) if (items.length) this.pages.set(page, items);
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

  destroy() {
    this.#destroyed = true;
    this.#pageListeners.clear();
    sessions.delete(this.pdf);
  }
}
