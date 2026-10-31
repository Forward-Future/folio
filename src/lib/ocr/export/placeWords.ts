// Turning recognized words into text that sits where the words are on the scan, for the invisible text layer of a saved copy.
import type { TextItem } from "../types";

/** One piece of text to draw: where, how far to squeeze it sideways to fit the word's box, and the space after it. */
export interface Run {
  /** The text matrix: the word's own transform, which already carries its size and slant. */
  matrix: number[];
  text: string;
  /** Horizontal scaling in percent (the PDF `Tz` operator) that makes the text exactly as wide as the word's ink. */
  squeeze: number;
  /** Set when a space follows: its scaling, which makes it span the gap to the next word. */
  gap?: number;
}

/**
 * What the saved copy's font (Helvetica, a standard font every reader has) can write: Windows-1252. A character outside
 * it becomes its plain letters if it has them ("ﬁ" is "fi", "ǎ" is "a"), is dropped if it is a lone accent, and is
 * otherwise written as "?"; the copy is only ever searched and selected, so a wrong character is better than a failed save.
 */
export function writable(text: string, supported: ReadonlySet<number>): string {
  let out = "";
  for (const char of text) {
    if (supported.has(char.codePointAt(0)!)) out += char;
    else if (/\s/u.test(char)) out += " ";
    else {
      const plain = char.normalize("NFKD").replace(/\p{M}/gu, "");
      out += !plain ? "" : [...plain].every((c) => supported.has(c.codePointAt(0)!)) ? plain : "?";
    }
  }
  return out;
}

/**
 * `widthOfEm(text)` is how wide the font draws `text` at a size of 1. A word is drawn at size 1 under its own
 * transform (which holds the real size), squeezed so that its advance is the width of its ink; the space that follows
 * it (the recognized item's text ends in one) is drawn squeezed to fill the gap up to the next word.
 */
export function placeWords(items: TextItem[], widthOfEm: (text: string) => number, supported: ReadonlySet<number>): Run[] {
  const runs: Run[] = [];
  for (const item of items) {
    const word = writable(item.str, supported).trim();
    const [a, b] = item.transform;
    const size = Math.hypot(a, b);
    const ink = item.inkWidth ?? item.width;
    const natural = word ? widthOfEm(word) : 0;
    if (!word || size <= 0 || natural <= 0 || ink <= 0 || ![...item.transform, ink, item.width].every(Number.isFinite)) continue;
    const run: Run = { matrix: item.transform, text: word, squeeze: (100 * ink) / (size * natural) };
    // (With no gap to bridge the space still has to be drawn, so it is squeezed to almost nothing rather than left out.)
    if (/\s$/.test(item.str)) run.gap = Math.max(1, (100 * (item.width - ink)) / (size * widthOfEm(" ")));
    runs.push(run);
  }
  return runs;
}
