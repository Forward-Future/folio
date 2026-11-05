import type { PDFViewer } from "./viewer";

interface Location {
  page: number;
  scale: string;
  rotation: number;
  left?: number;
  top?: number;
  destination?: unknown[];
}

export interface HistoryState { back: boolean; forward: boolean }
type HistoryChange = (state: HistoryState, followed?: { from: number; to: number }) => void;

/** PDF.js calls this only after resolving a valid link. Keep its history inside this reader,
 * rather than using the browser's joint history across Folio's document iframes. */
export class LinkHistory {
  private viewer: PDFViewer;
  private changed: HistoryChange;
  private entries: Location[] = [];
  private index = -1;
  private pending: Location | null = null;

  constructor(viewer: PDFViewer, changed: HistoryChange) {
    this.viewer = viewer;
    this.changed = changed;
  }

  reset() {
    this.entries = [];
    this.index = -1;
    this.pending = null;
    this.notify();
  }

  private notify(followed?: { from: number; to: number }) {
    this.changed({ back: this.index > 0, forward: this.index >= 0 && this.index < this.entries.length - 1 }, followed);
  }

  private capture(): Location | null {
    const viewer = this.viewer;
    if (!viewer.pdfDocument) return null;
    const page = viewer.currentPageNumber, view = viewer.getPageView(page - 1);
    if (!view?.pdfPage) return null;
    // Read the current geometry synchronously: updateviewarea can still describe the previous
    // frame when a reader follows another link or immediately presses Back.
    const box = viewer.container.getBoundingClientRect(), rect = view.div.getBoundingClientRect();
    const [left, top] = view.getPagePoint(box.left + viewer.container.clientLeft - rect.left - view.div.clientLeft,
      box.top + viewer.container.clientTop - rect.top - view.div.clientTop);
    return { page, left, top, scale: viewer.currentScaleValue, rotation: viewer.pagesRotation };
  }

  pushCurrentPosition() { this.pending = this.capture(); }

  push({ pageNumber, explicitDest }: { pageNumber: number; explicitDest?: unknown[] }) {
    const current = this.pending;
    this.pending = null;
    if (!current || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.viewer.pagesCount) return;
    if (this.index < 0) { this.entries.push(current); this.index = 0; }
    else this.entries[this.index] = current;
    this.entries.splice(this.index + 1);
    this.entries.push({ page: pageNumber, destination: explicitDest, scale: current.scale, rotation: current.rotation });
    this.index++;
    if (this.entries.length > 100) { this.entries.shift(); this.index--; }
    this.notify({ from: current.page, to: pageNumber });
  }

  pushPage(pageNumber: number) { this.push({ pageNumber }); }
  back() { this.move(-1); }
  forward() { this.move(1); }

  private move(direction: number) {
    const next = this.index + direction;
    if (next < 0 || next >= this.entries.length) return;
    if (!this.viewer.pdfDocument) return;
    const current = this.capture();
    // A destination's page may still be loading when Back is pressed. Its resolved
    // destination remains a usable Forward entry until we can capture its geometry.
    if (current) this.entries[this.index] = current;
    this.index = next;
    const location = this.entries[next];
    this.viewer.pagesRotation = location.rotation;
    this.viewer.currentScaleValue = location.scale;
    this.viewer.scrollPageIntoView({ pageNumber: location.page, allowNegativeOffset: true,
      destArray: location.destination ?? (location.left === undefined ? undefined
        : [null, { name: "XYZ" }, location.left, location.top, null]) });
    this.notify();
  }
}
