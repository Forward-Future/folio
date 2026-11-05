import type { PDFDocumentProxy } from "./pdf";

export const THUMB_W = 132;
// The tallest a thumbnail may be, so one long page can't fill the sidebar.
export const THUMB_MAX_H = 212;
// Room below each thumbnail for its padding and page number.
export const THUMB_ROW_EXTRA = 48;
// Thumbnails share one scale so pages keep their relative sizes, but none gets too small to recognize.
export const THUMB_MIN = 40;
// Page-size requests in flight at once. A document can have thousands of pages; asking for all of them together
// floods the PDF.js worker before the visible rows get an answer.
export const SIZE_REQUEST_LIMIT = 6;

export interface PageSize { width: number; height: number }

const LETTER: PageSize = { width: 612, height: 792 };

// One scale for every page, set by the largest page, so a letter page looks smaller than an 11x17 sheet beside it.
// A document of one page size comes out exactly as before: THUMB_W wide.
// Pages not measured yet (or that failed to load) borrow the first measured page's size.
// The visible rows can be a bookmark subset or an organizer permutation of the document's pages.
export function thumbLayout(sizes: readonly (PageSize | undefined)[] | null, count: number, rotation: number,
  order?: readonly number[] | null) {
  const turned = rotation % 180 !== 0;
  let fallback = LETTER;
  if (sizes) {
    for (const s of sizes) {
      if (s) { fallback = s; break; }
    }
  }
  const pages = Array.from({ length: count }, (_, i) => {
    const s = sizes?.[i] ?? fallback;
    return turned ? { width: s.height, height: s.width } : s;
  });
  // A loop rather than Math.max(...pages), which overflows the stack on very long documents.
  let maxW = 1;
  let maxH = 1;
  for (const p of pages) {
    maxW = Math.max(maxW, p.width);
    maxH = Math.max(maxH, p.height);
  }
  const scale = Math.min(THUMB_W / maxW, THUMB_MAX_H / maxH);
  const pageFrames = pages.map((p) => {
    const width = p.width * scale;
    const height = p.height * scale;
    // Enlarge small pages up to THUMB_MIN on their short side, but never past the frame limits: for a thin strip
    // the minimum is impossible, and the limits win.
    const lift = Math.max(1, Math.min(THUMB_MIN / Math.min(width, height), THUMB_W / width, THUMB_MAX_H / height));
    return { width: Math.max(1, Math.round(width * lift)), height: Math.max(1, Math.round(height * lift)) };
  });
  const frames = order ? order.map(n => pageFrames[n - 1]) : pageFrames;
  const tops = [0];
  for (const f of frames) tops.push(tops[tops.length - 1] + f.height + THUMB_ROW_EXTRA);
  return { frames, tops };
}

// The row that contains offset y, by binary search over the rows' top edges.
export function rowAt(tops: readonly number[], y: number) {
  let lo = 0;
  let hi = tops.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

// Where the list should scroll after row heights change, so the row at the top stays at the top and keeps the same
// part of it in view. Rows above it may have grown or shrunk as their page sizes arrived.
export function anchoredScrollTop(previousTops: readonly number[], nextTops: readonly number[], scrollTop: number) {
  const row = rowAt(previousTops, scrollTop);
  return (nextTops[row] ?? 0) + (scrollTop - (previousTops[row] ?? 0));
}

// Reads page sizes a few at a time: the rows passed to prioritize() first, then the rest in order.
// A page that fails to load is skipped and keeps its fallback size; the others still arrive.
export function loadPageSizes(pdf: Pick<PDFDocumentProxy, "numPages" | "getPage">, onSize: (index: number, size: PageSize) => void) {
  const count = pdf.numPages;
  const requested = new Uint8Array(count);
  let cursor = 0;
  let priority: number[] = [];
  let active = 0;
  let stopped = false;

  const next = () => {
    for (const i of priority) if (!requested[i]) return i;
    while (cursor < count && requested[cursor]) cursor++;
    return cursor < count ? cursor : -1;
  };
  const pump = () => {
    while (!stopped && active < SIZE_REQUEST_LIMIT) {
      const i = next();
      if (i < 0) return;
      requested[i] = 1;
      active++;
      pdf.getPage(i + 1)
        .then((p) => {
          if (stopped) return;
          const vp = p.getViewport({ scale: 1, rotation: p.rotate });
          onSize(i, { width: vp.width, height: vp.height });
        })
        .catch(() => {})
        .finally(() => {
          active--;
          pump();
        });
    }
  };

  return {
    // The pages in rows start..end-1 (zero-based) go to the front of the queue. `order` maps rows to pages
    // (1-based) when the organizer has rearranged them.
    prioritize(start: number, end: number, order?: readonly number[] | null) {
      const first = Math.max(0, Math.min(count, start));
      const last = Math.min(order?.length ?? count, end);
      priority = [];
      for (let row = first; row < last; row++) {
        const i = (order?.[row] ?? row + 1) - 1;
        if (i >= 0 && i < count) priority.push(i);
      }
      pump();
    },
    stop() {
      stopped = true;
    },
  };
}
