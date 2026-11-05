// Turning what Tesseract reads (words in pixels) into the text items pdf.js understands.
import type { TextItem } from "../types";

/** Below this, Tesseract is guessing. */
export const MIN_CONFIDENCE = 30;
/** ...but a long word it is unsure of is usually a real one on a damaged scan ("Image+Text" scored 22), unlike the one- and two-character specks. */
export const KEEP_LONG_WORD = 4;
/** A word with no letters or digits (":", "|", "=") is usually a speck on the paper, so it has to be near-certain to stay. Specks scored up to 73 on a noisy test scan. */
export const SYMBOL_MIN_CONFIDENCE = 80;
/** ...and a symbol much smaller than the text beside it is a speck however sure Tesseract is: specks of 1 to 4 px scored 80 to 85 beside text 40 px tall. */
export const SYMBOL_MIN_SIZE = 0.25;

export const STYLES = { ocr: { fontFamily: "sans-serif", ascent: 0.8, descent: -0.2, vertical: false } };

export interface Word { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }
export interface Line {
  words: Word[];
  bbox: Word["bbox"];
  baseline: Word["bbox"];
  /** Tesseract's own estimate of the line's height, from its row model. */
  rowAttributes?: { rowHeight: number };
}

const letterCount = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, "").length;

/** Whether one word is worth keeping, judged on its own (how sure Tesseract is, and what it is made of). */
export function keepWord(w: Word): boolean {
  if (!w.text.trim()) return false;
  const letters = letterCount(w.text);
  if (letters === 0) return w.confidence >= SYMBOL_MIN_CONFIDENCE;
  return w.confidence >= MIN_CONFIDENCE || letters >= KEEP_LONG_WORD;
}

/** The words of a line worth keeping: each one passes keepWord, and no symbol is a speck next to the line's text. */
export function keepWords(words: Word[]): Word[] {
  const kept = words.filter(keepWord);
  const textHeight = Math.max(0, ...kept.filter((w) => letterCount(w.text) > 0).map((w) => w.bbox.y1 - w.bbox.y0));
  return kept.filter((w) => letterCount(w.text) > 0 || Math.max(w.bbox.x1 - w.bbox.x0, w.bbox.y1 - w.bbox.y0) >= SYMBOL_MIN_SIZE * textHeight);
}

/** Tesseract reports pixels from the top left; pdf.js text items live in the page's own (unrotated, y-up) space. */
export function toItems(lines: Line[], viewport: { convertToPdfPoint(x: number, y: number): number[] }): TextItem[] {
  const items: TextItem[] = [];
  for (const line of lines) {
    const words = keepWords(line.words);
    const { baseline } = line;
    const run = baseline.x1 - baseline.x0 || 1;
    const baselineAt = (x: number) => baseline.y0 + ((baseline.y1 - baseline.y0) * (x - baseline.x0)) / run;
    // Tesseract's row height is steady, while word and line boxes swell to take in specks near them (a 41 px word came back 65 px tall).
    // Without it, fall back to the extent of the words kept.
    const rowHeight = line.rowAttributes?.rowHeight;
    const sizePx = Math.max(4, rowHeight && Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight
      : Math.max(0, ...words.map((w) => w.bbox.y1)) - Math.min(Infinity, ...words.map((w) => w.bbox.y0)));
    words.forEach((word, i) => {
      const last = i === words.length - 1;
      // A word's box ends at its last glyph; stretching it to the next word lets the space belong to it,
      // which is what pdf.js find and copy expect (words separated by whitespace in the text itself).
      const x0 = word.bbox.x0;
      const x1 = last ? word.bbox.x1 : Math.max(word.bbox.x1, words[i + 1].bbox.x0);
      const [ax, ay] = viewport.convertToPdfPoint(x0, baselineAt(x0));
      const [bx, by] = viewport.convertToPdfPoint(x1, baselineAt(x1));
      const length = Math.hypot(bx - ax, by - ay);
      if (!length) return;
      const [ux, uy] = [(bx - ax) / length, (by - ay) / length];
      const size = sizePx * (length / (x1 - x0));
      items.push({ str: last ? word.text : word.text + " ", dir: "ltr", fontName: "ocr", hasEOL: last,
        transform: [ux * size, uy * size, -uy * size, ux * size, ax, ay], width: length, height: size,
        inkWidth: (length * (word.bbox.x1 - x0)) / (x1 - x0) });
    });
  }
  return items;
}
