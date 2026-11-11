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
  paintImageXObjectRepeat?: number;
  paintImageMaskXObjectRepeat?: number;
  paintImageMaskXObjectGroup?: number;
  paintInlineImageXObjectGroup?: number;
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
  const measure = (matrix: number[]) => {
    const xs = [0, 1].flatMap(x => [0, 1].map(y => matrix[0] * x + matrix[2] * y + matrix[4]));
    const ys = [0, 1].flatMap(x => [0, 1].map(y => matrix[1] * x + matrix[3] * y + matrix[5]));
    best = Math.max(best, overlap([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], view));
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[];
    if (fn === ops.save) saved.push(ctm);
    else if (fn === ops.restore) ctm = saved.pop() ?? ctm;
    else if (fn === ops.transform) ctm = multiply(ctm, args as number[]);
    else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject || fn === ops.paintImageMaskXObject) measure(ctm);
    else if (ops.paintImageXObjectRepeat !== undefined && fn === ops.paintImageXObjectRepeat) {
      const [, sx, sy, positions] = args as [unknown, number, number, ArrayLike<number>];
      for (let j = 0; j + 1 < positions.length; j += 2) measure(multiply(ctm, [sx, 0, 0, sy, positions[j], positions[j + 1]]));
    } else if (ops.paintImageMaskXObjectRepeat !== undefined && fn === ops.paintImageMaskXObjectRepeat) {
      const [, sx, skx, sky, sy, positions] = args as [unknown, number, number, number, number, ArrayLike<number>];
      for (let j = 0; j + 1 < positions.length; j += 2) measure(multiply(ctm, [sx, skx, sky, sy, positions[j], positions[j + 1]]));
    } else if (ops.paintImageMaskXObjectGroup !== undefined && fn === ops.paintImageMaskXObjectGroup) {
      for (const image of args[0] as { transform: number[] }[]) measure(multiply(ctm, image.transform));
    } else if (ops.paintInlineImageXObjectGroup !== undefined && fn === ops.paintInlineImageXObjectGroup) {
      for (const image of args[1] as { transform: number[] }[]) measure(multiply(ctm, image.transform));
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
