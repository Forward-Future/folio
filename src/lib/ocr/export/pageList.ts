// Which pages of a saved copy carry recognized text, written into the PDF's document info as "1-3,5".
// A copy opened again reads this back, so those pages aren't offered for recognition a second time.

/** The document info entry that holds the list. */
export const PAGES_KEY = "FolioOcrPages";

/** More than any real list needs; a PDF is untrusted, so what is read from it is bounded. */
const MAX_LIST_LENGTH = 100_000;

/** Page numbers as the shortest list of ranges: [1, 2, 3, 5] is "1-3,5". */
export function formatPages(pages: Iterable<number>): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let end = i;
    while (sorted[end + 1] === sorted[end] + 1) end++;
    ranges.push(end === i ? `${sorted[i]}` : `${sorted[i]}-${sorted[end]}`);
    i = end + 1;
  }
  return ranges.join(",");
}

/** The page numbers in a list, within 1 to `total`. Anything that isn't a number or a range is skipped. */
export function parsePages(list: string, total: number): Set<number> {
  const pages = new Set<number>();
  for (const part of list.slice(0, MAX_LIST_LENGTH).split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) continue;
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    for (let n = Math.max(1, first); n <= Math.min(last, total); n++) pages.add(n);
  }
  return pages;
}
