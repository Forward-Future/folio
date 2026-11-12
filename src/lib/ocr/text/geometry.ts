// Where text sits on a page: boxes, overlap, and spotting recognized words that repeat the PDF's own text.
import type { Box, TextItem } from "../types";

/** Recognized words that sit at least this much on top of text the PDF already has are duplicates. */
export const DUPLICATE_OVERLAP = 0.5;

/** Axis-aligned box of a text item in page space (good enough for overlap tests, including rotated text). */
export function boxOf(item: TextItem): Box {
  const [a, b, c, d, e, f] = item.transform;
  const u = Math.hypot(a, b) || 1, v = Math.hypot(c, d) || 1;
  const along = [(a / u) * item.width, (b / u) * item.width], up = [(c / v) * item.height, (d / v) * item.height];
  const xs = [e, e + along[0], e + up[0], e + along[0] + up[0]], ys = [f, f + along[1], f + up[1], f + along[1] + up[1]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
export const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
export const overlap = (a: Box, b: Box) => area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);

/** Drops items that mostly sit on top of text the PDF already has. */
export function dropDuplicates(items: TextItem[], existing: Box[]): TextItem[] {
  return items.filter((item) => {
    // Judged by the word's own ink: its stretched width would count a wide gap (a table column) as uncovered.
    const box = boxOf(item.inkWidth === undefined ? item : { ...item, width: item.inkWidth });
    return !existing.some((other) => overlap(box, other) >= DUPLICATE_OVERLAP * area(box));
  });
}
