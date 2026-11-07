// Recognized text, kept locally in the same IndexedDB as Recent and notes (recent.ts owns the database and its schema).
import type { ScanLanguage } from "../../../scanLanguage";
import { OCR, ocrEpoch, tx } from "../../../recent";

// One record per scanned page, keyed by the document's content id, so a scan is only read once.

export interface StoredOcrPage {
  id: string;
  items: unknown[];
}

// English keeps the original key so existing caches remain useful. Other ordered language
// selections live below the same document prefix, so Remove from Recent deletes all of them.
export const ocrLanguageKey = (languages: ScanLanguage[]) => [...new Set(languages)].join("+") || "eng";
const prefix = (docId: string, languages: ScanLanguage[]) => {
  const key = ocrLanguageKey(languages);
  return key === "eng" ? `${docId}#` : `${docId}#${key}#`;
};
const ocrId = (docId: string, page: number, languages: ScanLanguage[]) => `${prefix(docId, languages)}${page}`;

export async function getOcrPages(docId: string, languages: ScanLanguage[] = ["eng"]): Promise<Map<number, unknown[]>> {
  const pages = new Map<number, unknown[]>();
  try {
    const start = prefix(docId, languages);
    const all = await tx<StoredOcrPage[]>("readonly", (s) => s.getAll(IDBKeyRange.bound(start, `${start}\uffff`)), OCR);
    for (const record of all) {
      const suffix = record.id.slice(start.length);
      // English's range also contains language-specific records; never interpret those as English.
      if (/^[1-9]\d*$/.test(suffix)) pages.set(Number(suffix), record.items);
    }
  } catch {
    /* best-effort, like notes */
  }
  return pages;
}

export async function saveOcrPage(docId: string, page: number, items: unknown[], epoch = ocrEpoch(docId), languages: ScanLanguage[] = ["eng"]) {
  try {
    if (epoch === null) return;
    await tx("readwrite", (s) => epoch === ocrEpoch(docId) ? s.put({ id: ocrId(docId, page, languages), items }) : s.get(ocrId(docId, page, languages)), OCR);
  } catch {
    /* best-effort, like notes */
  }
}
