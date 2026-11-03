// Telling a picture of text from a page that really has text on it.
import type { Box, TextItem } from "../types";
import { area, boxOf, overlap } from "./geometry";

/** A picture over this share of the page makes it a candidate scan... */
export const SCAN_IMAGE_COVER = 0.6;
/** ...unless the PDF's own text covers more than this share of it (a stamp or header covers a few percent; typed pages far more). */
export const SCAN_TEXT_COVER = 0.1;

/** The drawing operators that matter for finding pictures (pdf.js's OPS numbers; passed in so this file needs no pdf.js). */
export interface ImageOps {
  save: number;
  restore: number;
  transform: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintImageMaskXObject: number;
}

/** Same composition as pdf.js's Util.transform: `m2` is applied first, then `m1`. */
const multiply = (m1: number[], m2: number[]) => [
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];

/** Share of the page (`view`) covered by its largest picture, found by following the page's drawing operators. */
export function imageCover(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, ops: ImageOps, view: Box): number {
  let ctm = [1, 0, 0, 1, 0, 0];
  const saved: number[][] = [];
  let best = 0;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (fn === ops.save) saved.push(ctm);
    else if (fn === ops.restore) ctm = saved.pop() ?? ctm;
    else if (fn === ops.transform) ctm = multiply(ctm, argsArray[i] as number[]);
    else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject || fn === ops.paintImageMaskXObject) {
      // An image is drawn into the unit square under the current transform.
      const xs = [0, 1].flatMap((x) => [0, 1].map((y) => ctm[0] * x + ctm[2] * y + ctm[4]));
      const ys = [0, 1].flatMap((x) => [0, 1].map((y) => ctm[1] * x + ctm[3] * y + ctm[5]));
      best = Math.max(best, overlap([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], view));
    }
  }
  return best / area(view);
}

/** Share of the page (`view`) covered by the boxes of its own text items. */
export const textCover = (items: TextItem[], view: Box) => items.reduce((sum, item) => sum + area(boxOf(item)), 0) / area(view);

/**
 * True for pages that are pictures of text: nothing embedded, or a picture over most of the page with little text on it.
 * `imageShare` is only asked for when the text alone doesn't settle it, because measuring pictures means parsing the page.
 */
export async function isScanLike(embeddedCount: number, textShare: number, imageShare: () => number | Promise<number>): Promise<boolean> {
  if (!embeddedCount) return true;
  return textShare < SCAN_TEXT_COVER && (await imageShare()) >= SCAN_IMAGE_COVER;
}
