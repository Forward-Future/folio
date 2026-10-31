// Recognized text, kept locally in the same IndexedDB as Recent and notes (recent.ts owns the database and its schema).
import { OCR, tx } from "../../../recent";

// One record per scanned page, keyed by the document's content id, so a scan is only read once.

export interface StoredOcrPage {
  id: string;
  items: unknown[];
}

const ocrId = (docId: string, page: number) => `${docId}#${page}`;

export async function getOcrPages(docId: string): Promise<Map<number, unknown[]>> {
  const pages = new Map<number, unknown[]>();
  try {
    const all = await tx<StoredOcrPage[]>("readonly", (s) => s.getAll(IDBKeyRange.bound(`${docId}#`, `${docId}#\uffff`)), OCR);
    for (const record of all) pages.set(Number(record.id.slice(record.id.lastIndexOf("#") + 1)), record.items);
  } catch {
    /* best-effort, like notes */
  }
  return pages;
}

export async function saveOcrPage(docId: string, page: number, items: unknown[]) {
  try {
    await tx("readwrite", (s) => s.put({ id: ocrId(docId, page), items }), OCR);
  } catch {
    /* best-effort, like notes */
  }
}
