import type { PDFDocumentProxy } from "./pdf";

/** Each insertion has its own PDF identity, even when the same file is picked twice. */
export interface InsertedPdf { name: string; pdf: PDFDocumentProxy }

/** A page of the organized copy. */
export interface DraftPage { page: number; rotation?: number; source?: InsertedPdf }

export interface PageDraft {
  pages: DraftPage[];
  undo: DraftPage[][];
  redo: DraftPage[][];
  /** The saved copy of these pages, until they change again. */
  copy?: Uint8Array;
}

export const pageKey = (p: DraftPage) => p.source ? p.source.pdf.loadingTask.docId + "/" + p.page : String(p.page);

export const startDraft = (count: number): PageDraft =>
  ({ pages: Array.from({ length: count }, (_, i) => ({ page: i + 1 })), undo: [], redo: [] });

export const draftChanged = (draft: PageDraft, count: number) =>
  draft.pages.length !== count || draft.pages.some((p, i) => p.page !== i + 1 || !!p.rotation || !!p.source);

export const withPages = (draft: PageDraft, pages: DraftPage[]): PageDraft =>
  ({ pages, undo: [...draft.undo, draft.pages], redo: [] });

export function stepDraft(draft: PageDraft, back: boolean): PageDraft {
  const from = back ? draft.undo : draft.redo;
  const pages = from.at(-1);
  if (!pages) return draft;
  return back ? { pages, undo: draft.undo.slice(0, -1), redo: [...draft.redo, draft.pages] }
    : { pages, undo: [...draft.undo, draft.pages], redo: draft.redo.slice(0, -1) };
}

export function rotatePages(pages: DraftPage[], keys: ReadonlySet<string>, degrees: number) {
  return pages.map(p => keys.has(pageKey(p)) ? { ...p, rotation: ((p.rotation ?? 0) + degrees + 360) % 360 } : p);
}

/** Moves one page to a zero-based position; null when nothing would change. */
export function movePage(pages: readonly DraftPage[], key: string, to: number) {
  const from = pages.findIndex(p => pageKey(p) === key);
  if (from < 0 || from === to || !Number.isInteger(to) || to < 0 || to >= pages.length) return null;
  const next = pages.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** The remaining pages, and the one to select next: the page that took the first removed page's place. */
export function deletePages(pages: readonly DraftPage[], keys: ReadonlySet<string>) {
  const first = pages.findIndex(p => keys.has(pageKey(p)));
  const rest = pages.filter(p => !keys.has(pageKey(p)));
  return { pages: rest, next: rest[Math.min(Math.max(first, 0), rest.length - 1)] };
}
